//! InsiderIndex NAV vault (ERC-4626-style, unaudited hackathon program).
//!
//! - `deposit`: ONE user signature. Entry fee → fee account; net USDC → vault; shares mint at NAV
//!   (free USDC + sum(free leg balance x keeper mark)) in the same instruction. First deposit 1:1.
//! - `withdraw`: ONE user signature, instant USDC from the free buffer when it covers the value.
//! - `request_withdraw`: ONE user signature. Burns the shares and carves the owner's exact pro-rata
//!   slice (free USDC + every free leg) into a request PDA. Carved amounts are reserved: excluded
//!   from NAV and from keeper trading, so other holders are unaffected. The keeper then crosses legs
//!   against free vault USDC at the posted mark (`cross_request_leg`) or sells each slice via
//!   Jupiter/Raydium (`fulfill_swap`), and `settle_request` pays the USDC (min_usdc enforced on the
//!   total). Unsold legs are delivered in kind (`claim_in_kind`, keeper/admin anytime, owner after the
//!   timeout or immediately for an in-kind request). Payouts only ever go to the request owner.
//! - `admin_redeem_in_kind`: admin burns a holder's shares (Token-2022 permanent delegate) into an
//!   in-kind request payable only to that holder.
//! - `update_prices`: keeper marks with staleness + a per-update move band; `admin_set_prices` overrides.
//! - `keeper_swap`: keeper-signed CPI into a compile-time venue allowlist (Jupiter V6 exact-in routes,
//!   Raydium CLMM swap_v2; the mock venue only in `devnet` builds). Every vault token account passed
//!   to the venue is re-checked after the CPI; reserved amounts and the USDC buffer floor hold.
//! - `set_paused`: stops deposits, instant withdraw, keeper swaps and crosses; requests/claims stay open.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hash,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Burn, MintTo, TransferChecked};

declare_id!("HWHfPmyC2TKAL1tCdDZyK4ajG1HJnhbEMGRQzGfwYisB");

pub const JUPITER_V6: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
pub const RAYDIUM_CLMM: Pubkey = pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
/// Devnet/test-only fixed-price venue (Jupiter has no devnet deployment). Only allowed in `devnet` builds.
pub const MOCK_SWAP: Pubkey = pubkey!("9B8ryJEpnxpebZXzYNEyLkA3Ru173yQtC3BuP7Z1ce6R");
/// Jupiter V6 exact-in route instructions (sha256("global:<name>")[..8]).
pub const JUPITER_ROUTE_DISCRIMINATORS: [[u8; 8]; 4] = [
    [229, 23, 203, 151, 122, 227, 173, 42],  // route
    [193, 32, 155, 51, 65, 214, 156, 129],   // shared_accounts_route
    [187, 100, 250, 204, 49, 196, 175, 20],  // route_v2
    [209, 152, 83, 147, 124, 254, 216, 233], // shared_accounts_route_v2
];
/// Raydium CLMM `swap_v2` (direct-pool fallback when Jupiter has no route).
pub const RAYDIUM_CLMM_SWAP_V2: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];
pub const MAX_LEGS: usize = 25;
pub const MAX_INDEX_ID_LEN: usize = 64;
pub const BPS: u64 = 10_000;
/// Leg selector meaning "the vault USDC account".
pub const USDC_LEG: u8 = u8::MAX;
pub const SHARE_DECIMALS: u8 = 6;
pub const MAX_ENTRY_FEE_BPS: u16 = 100;
pub const MAX_BUFFER_BPS: u16 = 5_000;
/// Inflation-attack offset (virtual 1 share / 1 USDC). Keeps the first deposit 1:1.
pub const VIRTUAL_SHARES: u128 = 1_000_000;
pub const VIRTUAL_ASSETS: u128 = 1_000_000;

pub const VAULT_SEED: &[u8] = b"nav_vault";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
pub const SHARES_SEED: &[u8] = b"shares";
pub const REQUEST_SEED: &[u8] = b"request";

const TOKEN_ACCOUNT_LEN: usize = 165;

#[program]
pub mod nav_vault {
    use super::*;

    pub fn init_vault<'info>(ctx: Context<'_, '_, 'info, 'info, InitVault<'info>>, args: InitVaultArgs) -> Result<()> {
        require!(!args.index_id.is_empty() && args.index_id.len() <= MAX_INDEX_ID_LEN, VaultError::InvalidIndexId);
        require!(hash(args.index_id.as_bytes()).to_bytes() == args.index_seed, VaultError::InvalidIndexId);
        let n = args.weights_bps.len();
        require!(n >= 1 && n <= MAX_LEGS, VaultError::InvalidLegs);
        require!(ctx.remaining_accounts.len() == n * 2, VaultError::InvalidLegs);
        require!(args.max_price_age_secs > 0 && args.request_timeout_secs > 0, VaultError::InvalidConfig);
        require!(args.max_slippage_bps < BPS as u16 && args.max_price_move_bps > 0, VaultError::InvalidConfig);
        require!(args.entry_fee_bps <= MAX_ENTRY_FEE_BPS && args.buffer_bps <= MAX_BUFFER_BPS, VaultError::InvalidConfig);
        let weight_sum: u64 = args.weights_bps.iter().map(|w| *w as u64).sum();
        require!(weight_sum == BPS && args.weights_bps.iter().all(|w| *w > 0), VaultError::InvalidWeights);

        let usdc_mint = ctx.accounts.usdc_mint.key();
        let authority = ctx.accounts.authority.key();
        assert_clean_vault_account(&ctx.accounts.usdc_account.to_account_info(), &authority)?;
        let mut legs: Vec<Leg> = Vec::with_capacity(n);
        for i in 0..n {
            let mint = &ctx.remaining_accounts[2 * i];
            let account = &ctx.remaining_accounts[2 * i + 1];
            let token_program = *mint.owner;
            require!(is_token_program(&token_program), VaultError::InvalidLegs);
            require_keys_neq!(mint.key(), usdc_mint, VaultError::InvalidLegs);
            require!(legs.iter().all(|leg| leg.mint != mint.key()), VaultError::DuplicateLeg);
            let decimals = mint_decimals(mint)?;
            require_keys_eq!(*account.owner, token_program, VaultError::LegAccountMismatch);
            require_keys_eq!(token_mint(account)?, mint.key(), VaultError::LegAccountMismatch);
            assert_clean_vault_account(account, &authority)?;
            legs.push(Leg { mint: mint.key(), account: account.key(), token_program, decimals, weight_bps: args.weights_bps[i], price: 0, reserved: 0, cached_balance: 0 });
        }
        let vault = &mut ctx.accounts.vault;
        vault.admin = ctx.accounts.admin.key();
        vault.keeper = args.keeper;
        vault.index_seed = args.index_seed;
        vault.index_id = args.index_id;
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.usdc_mint = usdc_mint;
        vault.usdc_account = ctx.accounts.usdc_account.key();
        vault.fee_account = ctx.accounts.fee_account.key();
        vault.lookup_table = Pubkey::default();
        vault.max_price_age_secs = args.max_price_age_secs;
        vault.max_slippage_bps = args.max_slippage_bps;
        vault.max_price_move_bps = args.max_price_move_bps;
        vault.entry_fee_bps = args.entry_fee_bps;
        vault.buffer_bps = args.buffer_bps;
        vault.max_deposit_usdc = args.max_deposit_usdc;
        vault.request_timeout_secs = args.request_timeout_secs;
        vault.paused = false;
        vault.prices_updated_at = 0;
        vault.prices_updated_slot = 0;
        vault.reserved_usdc = 0;
        vault.bump = ctx.bumps.vault;
        vault.authority_bump = ctx.bumps.authority;
        vault.mint_authority_bump = ctx.bumps.mint_authority;
        vault.legs = legs;
        Ok(())
    }

    // ---------- admin ----------

    pub fn set_keeper(ctx: Context<AdminOnly>, keeper: Pubkey) -> Result<()> {
        ctx.accounts.vault.keeper = keeper;
        Ok(())
    }

    pub fn set_max_deposit(ctx: Context<AdminOnly>, max_deposit_usdc: u64) -> Result<()> {
        ctx.accounts.vault.max_deposit_usdc = max_deposit_usdc;
        Ok(())
    }

    /// Client convenience only: the table is never trusted on chain (every account is re-checked).
    pub fn set_lookup_table(ctx: Context<AdminOnly>, lookup_table: Pubkey) -> Result<()> {
        ctx.accounts.vault.lookup_table = lookup_table;
        Ok(())
    }

    /// Stops deposits, instant withdraw, keeper swaps/crosses. Requests, claims and settles stay open.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        emit!(PausedSet { vault: ctx.accounts.vault.key(), paused });
        Ok(())
    }

    /// Admin override of the per-update price band (remaining = vault leg accounts x N, refreshes the cache).
    pub fn admin_set_prices<'info>(ctx: Context<'_, '_, 'info, 'info, AdminPrices<'info>>, prices: Vec<u64>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        write_prices(vault, &prices, ctx.remaining_accounts, false)
    }

    // ---------- keeper marks ----------

    /// remaining = vault leg accounts x N (vault order): refreshes the balance cache used for the buffer rule.
    pub fn update_prices<'info>(ctx: Context<'_, '_, 'info, 'info, UpdatePrices<'info>>, prices: Vec<u64>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        write_prices(vault, &prices, ctx.remaining_accounts, true)
    }

    // ---------- user ----------

    pub fn deposit<'info>(ctx: Context<'_, '_, 'info, 'info, Deposit<'info>>, usdc_amount: u64, min_shares: u64) -> Result<()> {
        require!(usdc_amount > 0, VaultError::ZeroAmount);
        let vault = &ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        require!(vault.max_deposit_usdc == 0 || usdc_amount <= vault.max_deposit_usdc, VaultError::DepositAboveCap);
        require_keys_neq!(ctx.accounts.user.key(), vault.keeper, VaultError::KeeperCannotDeposit);
        assert_fresh_prices(vault)?;
        // Marks must be at least one slot old: the keeper cannot post a mark and trade on it in the same slot.
        require!(Clock::get()?.slot > vault.prices_updated_slot, VaultError::MarksTooNew);
        let n = vault.legs.len();
        require!(ctx.remaining_accounts.len() >= n, VaultError::MissingLegAccounts);
        let nav = vault_nav(vault, ctx.accounts.usdc_account.amount, &ctx.remaining_accounts[..n])?;
        let supply = ctx.accounts.share_mint.supply;
        // Entry fee (rounded up) is paid out of the deposit; shares mint on the net amount only.
        let fee = to_u64(((usdc_amount as u128) * (vault.entry_fee_bps as u128)).div_ceil(BPS as u128))?;
        let net = usdc_amount.checked_sub(fee).ok_or(error!(VaultError::MathOverflow))?;
        let shares = to_u64((net as u128) * (supply as u128 + VIRTUAL_SHARES) / (nav + VIRTUAL_ASSETS))?;
        require!(shares > 0, VaultError::ZeroShares);
        require!(shares >= min_shares, VaultError::SlippageExceeded);
        let usdc_program = ctx.accounts.token_program.to_account_info();
        let pay = |to: AccountInfo<'info>, amount: u64| -> Result<()> {
            if amount == 0 {
                return Ok(());
            }
            token_interface::transfer_checked(
                CpiContext::new(usdc_program.clone(), TransferChecked { from: ctx.accounts.user_usdc.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(), to, authority: ctx.accounts.user.to_account_info() }),
                amount,
                ctx.accounts.usdc_mint.decimals,
            )
        };
        pay(ctx.accounts.usdc_account.to_account_info(), net)?;
        pay(ctx.accounts.fee_account.to_account_info(), fee)?;
        let vault_key = vault.key();
        let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, vault_key.as_ref(), &[vault.mint_authority_bump]];
        token_interface::mint_to(
            CpiContext::new_with_signer(ctx.accounts.share_token_program.to_account_info(), MintTo { mint: ctx.accounts.share_mint.to_account_info(), to: ctx.accounts.user_shares.to_account_info(), authority: ctx.accounts.mint_authority.to_account_info() }, &[seeds]),
            shares,
        )?;
        emit!(Deposited { vault: vault_key, user: ctx.accounts.user.key(), usdc_in: usdc_amount, fee, shares_out: shares, nav_before: to_u64(nav)?, supply_before: supply });
        Ok(())
    }

    /// Instant USDC exit from the free buffer. Fails (`UsdcBufferShort`) when the buffer cannot cover
    /// the value; the client then uses `request_withdraw` instead.
    pub fn withdraw<'info>(ctx: Context<'_, '_, 'info, 'info, Withdraw<'info>>, shares: u64, min_usdc: u64) -> Result<()> {
        require!(shares > 0, VaultError::ZeroAmount);
        let vault = &ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        assert_fresh_prices(vault)?;
        let n = vault.legs.len();
        require!(ctx.remaining_accounts.len() >= n, VaultError::MissingLegAccounts);
        let supply = ctx.accounts.share_mint.supply;
        require!(shares <= supply, VaultError::InsufficientShares);
        let balance = ctx.accounts.usdc_account.amount;
        let nav = vault_nav(vault, balance, &ctx.remaining_accounts[..n])?;
        let value = to_u64((shares as u128) * (nav + VIRTUAL_ASSETS) / (supply as u128 + VIRTUAL_SHARES))?;
        require!(value >= min_usdc, VaultError::SlippageExceeded);
        require!(free(balance, vault.reserved_usdc) >= value, VaultError::UsdcBufferShort);
        token_interface::burn(
            CpiContext::new(ctx.accounts.share_token_program.to_account_info(), Burn { mint: ctx.accounts.share_mint.to_account_info(), from: ctx.accounts.user_shares.to_account_info(), authority: ctx.accounts.user.to_account_info() }),
            shares,
        )?;
        transfer_from_vault(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.usdc_account.to_account_info(), &ctx.accounts.usdc_mint.to_account_info(), &ctx.accounts.user_usdc.to_account_info(), &ctx.accounts.authority.to_account_info(), vault, value, ctx.accounts.usdc_mint.decimals)?;
        emit!(Withdrawn { vault: vault.key(), user: ctx.accounts.user.key(), shares, usdc_out: value });
        Ok(())
    }

    /// Burn `shares` and carve the owner's pro-rata slice into a request (remaining = vault leg accounts x N).
    pub fn request_withdraw<'info>(ctx: Context<'_, '_, 'info, 'info, RequestWithdraw<'info>>, args: RequestArgs) -> Result<()> {
        require!(args.shares > 0, VaultError::ZeroAmount);
        let supply = ctx.accounts.share_mint.supply;
        require!(args.shares <= supply, VaultError::InsufficientShares);
        token_interface::burn(
            CpiContext::new(ctx.accounts.share_token_program.to_account_info(), Burn { mint: ctx.accounts.share_mint.to_account_info(), from: ctx.accounts.user_shares.to_account_info(), authority: ctx.accounts.user.to_account_info() }),
            args.shares,
        )?;
        let now = Clock::get()?.unix_timestamp;
        let vault = &mut ctx.accounts.vault;
        let in_kind_now = args.in_kind_now || vault.paused || assert_fresh_prices(vault).is_err();
        let request = &mut ctx.accounts.request;
        request.bump = ctx.bumps.request;
        carve(vault, request, ctx.accounts.user.key(), args, supply, ctx.accounts.usdc_account.amount, ctx.remaining_accounts, now, in_kind_now, false)
    }

    /// Admin-forced pro-rata in-kind redeem FOR a holder (Token-2022 permanent delegate burn). The
    /// request pays only that holder; the admin can never receive it.
    pub fn admin_redeem_in_kind<'info>(ctx: Context<'_, '_, 'info, 'info, AdminRedeem<'info>>, shares: u64, nonce: u64) -> Result<()> {
        require!(shares > 0, VaultError::ZeroAmount);
        let supply = ctx.accounts.share_mint.supply;
        require!(shares <= supply, VaultError::InsufficientShares);
        let vault_key = ctx.accounts.vault.key();
        let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, vault_key.as_ref(), &[ctx.accounts.vault.mint_authority_bump]];
        token_interface::burn(
            CpiContext::new_with_signer(ctx.accounts.share_token_program.to_account_info(), Burn { mint: ctx.accounts.share_mint.to_account_info(), from: ctx.accounts.holder_shares.to_account_info(), authority: ctx.accounts.mint_authority.to_account_info() }, &[seeds]),
            shares,
        )?;
        let now = Clock::get()?.unix_timestamp;
        let vault = &mut ctx.accounts.vault;
        let request = &mut ctx.accounts.request;
        request.bump = ctx.bumps.request;
        let args = RequestArgs { shares, min_usdc: 0, nonce, in_kind_now: true };
        carve(vault, request, ctx.accounts.holder.key(), args, supply, ctx.accounts.usdc_account.amount, ctx.remaining_accounts, now, true, true)
    }

    /// Deliver listed legs of a request in kind (and any USDC owed) to the request owner.
    /// Caller: owner (after `claimable_at`), keeper or admin (anytime). remaining = (vault leg account,
    /// leg mint, owner leg account, leg token program) per listed leg. Closes the request when empty.
    pub fn claim_in_kind<'info>(ctx: Context<'_, '_, 'info, 'info, Claim<'info>>, legs: Vec<u8>) -> Result<()> {
        let caller = ctx.accounts.caller.key();
        let vault = &mut ctx.accounts.vault;
        let request = &mut ctx.accounts.request;
        let now = Clock::get()?.unix_timestamp;
        let privileged = caller == vault.keeper || caller == vault.admin;
        require!(privileged || (caller == request.owner && now >= request.claimable_at), VaultError::NotClaimable);
        require!(ctx.remaining_accounts.len() == legs.len() * 4, VaultError::MissingLegAccounts);
        let authority_info = ctx.accounts.authority.to_account_info();
        let owner = request.owner;
        for (k, leg_index) in legs.iter().enumerate() {
            let i = *leg_index as usize;
            require!(i < vault.legs.len(), VaultError::InvalidSwapLegs);
            let amount = request.leg_amounts[i];
            let group = &ctx.remaining_accounts[4 * k..4 * k + 4];
            let leg = vault.legs[i].clone();
            require_keys_eq!(group[0].key(), leg.account, VaultError::LegAccountMismatch);
            require_keys_eq!(group[1].key(), leg.mint, VaultError::LegAccountMismatch);
            require_keys_eq!(group[3].key(), leg.token_program, VaultError::LegAccountMismatch);
            require_keys_eq!(token_mint(&group[2])?, leg.mint, VaultError::UserAccountMismatch);
            require_keys_eq!(token_owner(&group[2])?, owner, VaultError::UserAccountMismatch);
            transfer_from_vault(&group[3], &group[0], &group[1], &group[2], &authority_info, vault, amount, leg.decimals)?;
            request.leg_amounts[i] = 0;
            let leg = &mut vault.legs[i];
            leg.reserved = leg.reserved.saturating_sub(amount);
            leg.cached_balance = leg.cached_balance.saturating_sub(amount);
        }
        let usdc = request.usdc_owed;
        transfer_from_vault(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.usdc_account.to_account_info(), &ctx.accounts.usdc_mint.to_account_info(), &ctx.accounts.owner_usdc.to_account_info(), &authority_info, vault, usdc, ctx.accounts.usdc_mint.decimals)?;
        request.usdc_owed = 0;
        vault.reserved_usdc = vault.reserved_usdc.saturating_sub(usdc);
        emit!(Claimed { vault: vault.key(), request: request.key(), owner, legs: legs.clone(), usdc });
        if request.leg_amounts.iter().all(|a| *a == 0) {
            let owner_info = ctx.accounts.owner.to_account_info();
            ctx.accounts.request.close(owner_info)?;
        }
        Ok(())
    }

    /// All legs converted: pay the USDC total (>= min_usdc) to the owner and close. Caller: owner or keeper.
    pub fn settle_request(ctx: Context<Settle>) -> Result<()> {
        let caller = ctx.accounts.caller.key();
        let vault = &mut ctx.accounts.vault;
        let request = &mut ctx.accounts.request;
        require!(caller == request.owner || caller == vault.keeper, VaultError::NotClaimable);
        require!(request.leg_amounts.iter().all(|a| *a == 0), VaultError::RequestNotConverted);
        let usdc = request.usdc_owed;
        require!(usdc >= request.min_usdc, VaultError::MinUsdcUnmet);
        transfer_from_vault(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.usdc_account.to_account_info(), &ctx.accounts.usdc_mint.to_account_info(), &ctx.accounts.owner_usdc.to_account_info(), &ctx.accounts.authority.to_account_info(), vault, usdc, ctx.accounts.usdc_mint.decimals)?;
        vault.reserved_usdc = vault.reserved_usdc.saturating_sub(usdc);
        emit!(Settled { vault: vault.key(), request: request.key(), owner: request.owner, usdc });
        let owner_info = ctx.accounts.owner.to_account_info();
        ctx.accounts.request.close(owner_info)?;
        Ok(())
    }

    // ---------- keeper ----------

    /// Net a request's leg slice against free vault USDC at the posted mark: the slice returns to the
    /// free pool and the request is credited its mark value. No venue, no slippage.
    pub fn cross_request_leg(ctx: Context<Cross>, leg: u8) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        assert_fresh_prices(vault)?;
        let i = leg as usize;
        require!(i < vault.legs.len(), VaultError::InvalidSwapLegs);
        let request = &mut ctx.accounts.request;
        let slice = request.leg_amounts[i];
        require!(slice > 0, VaultError::ZeroAmount);
        let value = to_u64(leg_value(&vault.legs[i], slice))?;
        let free_usdc = free(token_amount(&ctx.accounts.usdc_account.to_account_info())?, vault.reserved_usdc);
        require!(free_usdc >= value, VaultError::UsdcBufferShort);
        request.leg_amounts[i] = 0;
        request.usdc_owed += value;
        vault.reserved_usdc += value;
        vault.legs[i].reserved = vault.legs[i].reserved.saturating_sub(slice);
        emit!(Crossed { vault: vault.key(), request: request.key(), leg, amount: slice, usdc: value });
        Ok(())
    }

    /// Rebalance swap on FREE inventory. remaining = the venue instruction's accounts.
    pub fn keeper_swap<'info>(ctx: Context<'_, '_, 'info, 'info, KeeperSwap<'info>>, args: SwapArgs) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        let (spent, received) = venue_swap(vault, &ctx.accounts.authority, &ctx.accounts.swap_program, ctx.remaining_accounts, &args)?;
        if args.in_leg == USDC_LEG && vault.buffer_bps > 0 {
            // Buying a leg may not take free USDC below buffer_bps of the (cached) post-swap NAV.
            let usdc_after = free(token_amount(&find_vault_account(ctx.remaining_accounts, &vault.usdc_account)?)?, vault.reserved_usdc);
            let mut nav = usdc_after as u128;
            for leg in vault.legs.iter() {
                nav += leg_value(leg, free(leg.cached_balance, leg.reserved));
            }
            require!((usdc_after as u128) * (BPS as u128) >= nav * (vault.buffer_bps as u128), VaultError::BufferBreached);
        }
        emit!(Swapped { vault: vault.key(), in_leg: args.in_leg, out_leg: args.out_leg, spent, received, request: None });
        Ok(())
    }

    /// Sell a request's reserved leg slice into USDC credited to that request.
    pub fn fulfill_swap<'info>(ctx: Context<'_, '_, 'info, 'info, FulfillSwap<'info>>, args: SwapArgs) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        require!(args.out_leg == USDC_LEG && args.in_leg != USDC_LEG, VaultError::InvalidSwapLegs);
        let i = args.in_leg as usize;
        require!(i < vault.legs.len(), VaultError::InvalidSwapLegs);
        let request = &mut ctx.accounts.request;
        require!(args.amount_in <= request.leg_amounts[i], VaultError::SwapOverspent);
        // The slice is reserved: release it for the swap, then account the actual spend.
        vault.legs[i].reserved -= args.amount_in;
        let (spent, received) = venue_swap(vault, &ctx.accounts.authority, &ctx.accounts.swap_program, ctx.remaining_accounts, &args)?;
        vault.legs[i].reserved += args.amount_in - spent;
        request.leg_amounts[i] -= spent;
        request.usdc_owed += received;
        vault.reserved_usdc += received;
        emit!(Swapped { vault: vault.key(), in_leg: args.in_leg, out_leg: args.out_leg, spent, received, request: Some(request.key()) });
        Ok(())
    }
}

// ---------- helpers ----------

fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(VaultError::MathOverflow))
}

fn free(balance: u64, reserved: u64) -> u64 {
    balance.saturating_sub(reserved)
}

fn is_token_program(key: &Pubkey) -> bool {
    *key == anchor_spl::token::ID || *key == anchor_spl::token_2022::ID
}

fn token_data<'a>(info: &'a AccountInfo) -> Result<std::cell::Ref<'a, &'a mut [u8]>> {
    require!(is_token_program(info.owner), VaultError::NotATokenAccount);
    let data = info.try_borrow_data()?;
    require!(data.len() >= TOKEN_ACCOUNT_LEN, VaultError::NotATokenAccount);
    Ok(data)
}

fn token_amount(info: &AccountInfo) -> Result<u64> {
    let data = token_data(info)?;
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

fn token_mint(info: &AccountInfo) -> Result<Pubkey> {
    let data = token_data(info)?;
    Ok(Pubkey::new_from_array(data[0..32].try_into().unwrap()))
}

fn token_owner(info: &AccountInfo) -> Result<Pubkey> {
    let data = token_data(info)?;
    Ok(Pubkey::new_from_array(data[32..64].try_into().unwrap()))
}

/// Vault token accounts must stay owned by the authority PDA with no delegate and no close authority.
fn assert_clean_vault_account(info: &AccountInfo, authority: &Pubkey) -> Result<()> {
    let data = token_data(info)?;
    require_keys_eq!(Pubkey::new_from_array(data[32..64].try_into().unwrap()), *authority, VaultError::VaultAccountAuthority);
    let delegate_tag = u32::from_le_bytes(data[72..76].try_into().unwrap());
    let close_tag = u32::from_le_bytes(data[129..133].try_into().unwrap());
    require!(delegate_tag == 0 && close_tag == 0, VaultError::VaultAccountAuthority);
    Ok(())
}

fn mint_decimals(info: &AccountInfo) -> Result<u8> {
    let data = info.try_borrow_data()?;
    require!(data.len() >= 82, VaultError::InvalidLegs);
    require!(data[45] == 1, VaultError::InvalidLegs);
    Ok(data[44])
}

/// Only pinned venues and exact-in swap instructions may receive the authority signature.
fn assert_allowed_swap(program: &Pubkey, data: &[u8]) -> Result<()> {
    require!(data.len() >= 8, VaultError::SwapProgramNotAllowed);
    let disc: [u8; 8] = data[..8].try_into().unwrap();
    if *program == JUPITER_V6 {
        require!(JUPITER_ROUTE_DISCRIMINATORS.contains(&disc), VaultError::SwapProgramNotAllowed);
        return Ok(());
    }
    if *program == RAYDIUM_CLMM {
        require!(disc == RAYDIUM_CLMM_SWAP_V2, VaultError::SwapProgramNotAllowed);
        return Ok(());
    }
    #[cfg(feature = "devnet")]
    if *program == MOCK_SWAP {
        return Ok(());
    }
    err!(VaultError::SwapProgramNotAllowed)
}

fn assert_fresh_prices(vault: &Vault) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(vault.prices_updated_at > 0, VaultError::StalePrices);
    require!(now.saturating_sub(vault.prices_updated_at) <= vault.max_price_age_secs as i64, VaultError::StalePrices);
    Ok(())
}

fn leg_value(leg: &Leg, amount: u64) -> u128 {
    (amount as u128) * (leg.price as u128) / 10u128.pow(leg.decimals as u32)
}

fn slot_value(vault: &Vault, slot: u8, amount: u64) -> u128 {
    if slot == USDC_LEG {
        amount as u128
    } else {
        leg_value(&vault.legs[slot as usize], amount)
    }
}

/// NAV in USDC raw units over FREE balances (reserved request slices excluded).
fn vault_nav(vault: &Vault, usdc_balance: u64, leg_accounts: &[AccountInfo]) -> Result<u128> {
    let mut total = free(usdc_balance, vault.reserved_usdc) as u128;
    for (i, leg) in vault.legs.iter().enumerate() {
        let info = &leg_accounts[i];
        require_keys_eq!(info.key(), leg.account, VaultError::LegAccountMismatch);
        require_keys_eq!(*info.owner, leg.token_program, VaultError::LegAccountMismatch);
        total += leg_value(leg, free(token_amount(info)?, leg.reserved));
    }
    Ok(total)
}

fn write_prices(vault: &mut Account<Vault>, prices: &[u64], leg_accounts: &[AccountInfo], banded: bool) -> Result<()> {
    require!(prices.len() == vault.legs.len(), VaultError::InvalidPrices);
    require!(prices.iter().all(|p| *p > 0), VaultError::InvalidPrices);
    require!(leg_accounts.len() >= vault.legs.len(), VaultError::MissingLegAccounts);
    let band = vault.max_price_move_bps as u128;
    for (i, price) in prices.iter().enumerate() {
        let leg = &mut vault.legs[i];
        if banded && leg.price > 0 {
            let old = leg.price as u128;
            let moved = (*price as u128).abs_diff(old);
            require!(moved * (BPS as u128) <= old * band, VaultError::PriceMoveTooLarge);
        }
        let info = &leg_accounts[i];
        require_keys_eq!(info.key(), leg.account, VaultError::LegAccountMismatch);
        leg.cached_balance = token_amount(info)?;
        leg.price = *price;
    }
    let clock = Clock::get()?;
    vault.prices_updated_at = clock.unix_timestamp;
    vault.prices_updated_slot = clock.slot;
    emit!(PricesUpdated { vault: vault.key(), prices: prices.to_vec(), at: vault.prices_updated_at, admin_override: !banded });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn carve(vault: &mut Account<Vault>, request: &mut Account<WithdrawRequest>, owner: Pubkey, args: RequestArgs, supply: u64, usdc_balance: u64, leg_accounts: &[AccountInfo], now: i64, in_kind_now: bool, admin_forced: bool) -> Result<()> {
    let n = vault.legs.len();
    require!(leg_accounts.len() >= n, VaultError::MissingLegAccounts);
    let fresh = assert_fresh_prices(vault).is_ok();
    let mut value: u128 = 0;
    let usdc_slice = to_u64((free(usdc_balance, vault.reserved_usdc) as u128) * (args.shares as u128) / (supply as u128))?;
    let mut amounts = Vec::with_capacity(n);
    for i in 0..n {
        let info = &leg_accounts[i];
        let leg = &mut vault.legs[i];
        require_keys_eq!(info.key(), leg.account, VaultError::LegAccountMismatch);
        let balance = token_amount(info)?;
        let slice = to_u64((free(balance, leg.reserved) as u128) * (args.shares as u128) / (supply as u128))?;
        leg.reserved += slice;
        leg.cached_balance = balance;
        value += leg_value(leg, slice);
        amounts.push(slice);
    }
    vault.reserved_usdc += usdc_slice;
    request.vault = vault.key();
    request.owner = owner;
    request.nonce = args.nonce;
    request.shares = args.shares;
    request.min_usdc = args.min_usdc;
    request.created_at = now;
    request.claimable_at = if in_kind_now { now } else { now + vault.request_timeout_secs as i64 };
    request.usdc_owed = usdc_slice;
    request.value_at_request = if fresh { to_u64(value + usdc_slice as u128)? } else { 0 };
    request.admin_forced = admin_forced;
    request.leg_amounts = amounts;
    emit!(Requested { vault: vault.key(), request: request.key(), owner, shares: args.shares, usdc: usdc_slice, in_kind_now, admin_forced });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn transfer_from_vault<'info>(token_program: &AccountInfo<'info>, from: &AccountInfo<'info>, mint: &AccountInfo<'info>, to: &AccountInfo<'info>, authority: &AccountInfo<'info>, vault: &Account<'info, Vault>, amount: u64, decimals: u8) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let vault_key = vault.key();
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, vault_key.as_ref(), &[vault.authority_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(token_program.clone(), TransferChecked { from: from.clone(), mint: mint.clone(), to: to.clone(), authority: authority.clone() }, &[seeds]),
        amount,
        decimals,
    )
}

fn vault_slot(vault: &Vault, key: &Pubkey) -> Option<u8> {
    if *key == vault.usdc_account {
        return Some(USDC_LEG);
    }
    vault.legs.iter().position(|leg| leg.account == *key).map(|i| i as u8)
}

fn find_vault_account<'info>(accounts: &[AccountInfo<'info>], key: &Pubkey) -> Result<AccountInfo<'info>> {
    accounts.iter().find(|a| a.key == key).cloned().ok_or(error!(VaultError::MissingLegAccounts))
}

/// CPI one venue swap signed by the authority PDA. Every vault token account among the venue accounts
/// is snapshotted: only `in_leg` may decrease (by <= amount_in, never below its reserved amount),
/// `out_leg` must rise by >= min_out, authorities stay clean, and value out >= value in x (1 - slippage)
/// at posted marks. Accounts the venue is not given cannot be touched. Returns (spent, received).
fn venue_swap<'info>(vault: &mut Account<'info, Vault>, authority: &UncheckedAccount<'info>, swap_program: &UncheckedAccount<'info>, accounts: &[AccountInfo<'info>], args: &SwapArgs) -> Result<(u64, u64)> {
    let n = vault.legs.len();
    require!(args.in_leg != args.out_leg, VaultError::InvalidSwapLegs);
    require!(args.in_leg == USDC_LEG || (args.in_leg as usize) < n, VaultError::InvalidSwapLegs);
    require!(args.out_leg == USDC_LEG || (args.out_leg as usize) < n, VaultError::InvalidSwapLegs);
    require!(args.amount_in > 0, VaultError::ZeroAmount);
    assert_allowed_swap(&swap_program.key(), &args.data)?;
    assert_fresh_prices(vault)?;
    let authority_key = authority.key();
    let mut snaps: Vec<(u8, usize, u64)> = Vec::new();
    for (idx, info) in accounts.iter().enumerate() {
        if let Some(slot) = vault_slot(vault, info.key) {
            if snaps.iter().all(|s| s.0 != slot) {
                snaps.push((slot, idx, token_amount(info)?));
            }
        }
    }
    let before_of = |slot: u8| snaps.iter().find(|s| s.0 == slot).map(|s| (s.1, s.2));
    let (in_idx, in_before) = before_of(args.in_leg).ok_or(error!(VaultError::MissingLegAccounts))?;
    let (out_idx, out_before) = before_of(args.out_leg).ok_or(error!(VaultError::MissingLegAccounts))?;

    let metas: Vec<AccountMeta> = accounts.iter().map(|a| AccountMeta { pubkey: a.key(), is_signer: a.is_signer || a.key() == authority_key, is_writable: a.is_writable }).collect();
    let ix = Instruction { program_id: swap_program.key(), accounts: metas, data: args.data.clone() };
    let mut infos: Vec<AccountInfo<'info>> = accounts.to_vec();
    infos.push(authority.to_account_info());
    infos.push(swap_program.to_account_info());
    let vault_key = vault.key();
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, vault_key.as_ref(), &[vault.authority_bump]];
    invoke_signed(&ix, &infos, &[seeds])?;

    for (slot, idx, before) in snaps.iter() {
        let info = &accounts[*idx];
        assert_clean_vault_account(info, &authority_key)?;
        let after = token_amount(info)?;
        if *slot != args.in_leg {
            require!(after >= *before, VaultError::SwapDrainedAccount);
        }
        let reserved = if *slot == USDC_LEG { vault.reserved_usdc } else { vault.legs[*slot as usize].reserved };
        require!(after >= reserved, VaultError::SwapSpentReserved);
    }
    let in_after = token_amount(&accounts[in_idx])?;
    let out_after = token_amount(&accounts[out_idx])?;
    require!(in_after <= in_before, VaultError::SwapInvalidDelta);
    let spent = in_before - in_after;
    require!(spent <= args.amount_in, VaultError::SwapOverspent);
    let received = out_after - out_before;
    require!(received >= args.min_out, VaultError::SlippageExceeded);
    let (value_in, value_out) = (slot_value(vault, args.in_leg, spent), slot_value(vault, args.out_leg, received));
    require!(value_out * (BPS as u128) >= value_in * ((BPS - vault.max_slippage_bps as u64) as u128), VaultError::SwapPriceBound);
    if args.in_leg != USDC_LEG {
        let leg = &mut vault.legs[args.in_leg as usize];
        leg.cached_balance = leg.cached_balance.saturating_sub(spent);
    }
    if args.out_leg != USDC_LEG {
        let leg = &mut vault.legs[args.out_leg as usize];
        leg.cached_balance = leg.cached_balance.saturating_add(received);
    }
    Ok((spent, received))
}

// ---------- accounts ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitVaultArgs {
    pub index_seed: [u8; 32],
    pub index_id: String,
    pub keeper: Pubkey,
    pub max_price_age_secs: u32,
    pub max_slippage_bps: u16,
    pub max_price_move_bps: u16,
    pub entry_fee_bps: u16,
    pub buffer_bps: u16,
    /// Per-deposit USDC cap in raw units (0 = no cap).
    pub max_deposit_usdc: u64,
    pub request_timeout_secs: u32,
    pub weights_bps: Vec<u16>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct RequestArgs {
    pub shares: u64,
    pub min_usdc: u64,
    pub nonce: u64,
    /// Owner may claim the slice in kind immediately (price-free emergency exit).
    pub in_kind_now: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SwapArgs {
    pub in_leg: u8,
    pub out_leg: u8,
    pub amount_in: u64,
    pub min_out: u64,
    pub data: Vec<u8>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub index_seed: [u8; 32],
    #[max_len(64)]
    pub index_id: String,
    pub share_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_account: Pubkey,
    pub fee_account: Pubkey,
    /// Address lookup table clients use to fit transactions (never trusted on chain).
    pub lookup_table: Pubkey,
    pub max_price_age_secs: u32,
    pub max_slippage_bps: u16,
    pub max_price_move_bps: u16,
    pub entry_fee_bps: u16,
    pub buffer_bps: u16,
    pub max_deposit_usdc: u64,
    pub request_timeout_secs: u32,
    pub paused: bool,
    pub prices_updated_at: i64,
    pub prices_updated_slot: u64,
    /// USDC reserved for open withdraw requests (excluded from NAV and keeper trading).
    pub reserved_usdc: u64,
    pub bump: u8,
    pub authority_bump: u8,
    pub mint_authority_bump: u8,
    #[max_len(25)]
    pub legs: Vec<Leg>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Leg {
    pub mint: Pubkey,
    pub account: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub weight_bps: u16,
    pub price: u64,
    /// Amount reserved for open withdraw requests.
    pub reserved: u64,
    /// Last observed balance (refreshed by update_prices/requests, adjusted by swaps); buffer rule only.
    pub cached_balance: u64,
}

#[account]
#[derive(InitSpace)]
pub struct WithdrawRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub shares: u64,
    pub min_usdc: u64,
    pub created_at: i64,
    pub claimable_at: i64,
    pub usdc_owed: u64,
    pub value_at_request: u64,
    pub admin_forced: bool,
    pub bump: u8,
    #[max_len(25)]
    pub leg_amounts: Vec<u64>,
}

#[derive(Accounts)]
#[instruction(args: InitVaultArgs)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED, args.index_seed.as_ref()], bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: PDA that owns every vault token account and signs swaps/transfers out.
    #[account(seeds = [AUTHORITY_SEED, vault.key().as_ref()], bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: PDA that is the share mint authority and permanent delegate (never passed to swap CPIs).
    #[account(seeds = [MINT_AUTHORITY_SEED, vault.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(init, payer = admin, seeds = [SHARES_SEED, vault.key().as_ref()], bump, mint::decimals = SHARE_DECIMALS, mint::authority = mint_authority, mint::token_program = share_token_program, extensions::permanent_delegate::delegate = mint_authority)]
    pub share_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(constraint = usdc_account.mint == usdc_mint.key() @ VaultError::LegAccountMismatch)]
    pub usdc_account: Box<Account<'info, TokenAccount>>,
    /// USDC account that receives the entry fee. Must not be a vault account.
    #[account(constraint = fee_account.mint == usdc_mint.key() @ VaultError::LegAccountMismatch, constraint = fee_account.key() != usdc_account.key() @ VaultError::InvalidConfig)]
    pub fee_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub share_token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin)]
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
pub struct AdminPrices<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin)]
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
pub struct UpdatePrices<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, has_one = keeper @ VaultError::NotKeeper)]
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub user: Signer<'info>,
    #[account(has_one = share_mint, has_one = usdc_mint, has_one = usdc_account, has_one = fee_account)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: share mint authority PDA.
    #[account(seeds = [MINT_AUTHORITY_SEED, vault.key().as_ref()], bump = vault.mint_authority_bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub usdc_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = share_mint, token::authority = user, token::token_program = share_token_program)]
    pub user_shares: Box<InterfaceAccount<'info, token_interface::TokenAccount>>,
    #[account(mut)]
    pub fee_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub share_token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,
    #[account(has_one = share_mint, has_one = usdc_mint, has_one = usdc_account)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: vault token authority PDA.
    #[account(seeds = [AUTHORITY_SEED, vault.key().as_ref()], bump = vault.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub usdc_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = share_mint, token::authority = user, token::token_program = share_token_program)]
    pub user_shares: Box<InterfaceAccount<'info, token_interface::TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub share_token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
#[instruction(args: RequestArgs)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, has_one = share_mint, has_one = usdc_account)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = user, token::token_program = share_token_program)]
    pub user_shares: Box<InterfaceAccount<'info, token_interface::TokenAccount>>,
    pub usdc_account: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = user, space = 8 + WithdrawRequest::INIT_SPACE, seeds = [REQUEST_SEED, vault.key().as_ref(), user.key().as_ref(), &args.nonce.to_le_bytes()], bump)]
    pub request: Box<Account<'info, WithdrawRequest>>,
    pub share_token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(shares: u64, nonce: u64)]
pub struct AdminRedeem<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin, has_one = share_mint, has_one = usdc_account)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: the holder being redeemed; only ever the payout recipient.
    pub holder: UncheckedAccount<'info>,
    #[account(mut, token::mint = share_mint, token::authority = holder, token::token_program = share_token_program)]
    pub holder_shares: Box<InterfaceAccount<'info, token_interface::TokenAccount>>,
    /// CHECK: share mint authority / permanent delegate PDA.
    #[account(seeds = [MINT_AUTHORITY_SEED, vault.key().as_ref()], bump = vault.mint_authority_bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,
    pub usdc_account: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, space = 8 + WithdrawRequest::INIT_SPACE, seeds = [REQUEST_SEED, vault.key().as_ref(), holder.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub request: Box<Account<'info, WithdrawRequest>>,
    pub share_token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub caller: Signer<'info>,
    #[account(mut, has_one = usdc_mint, has_one = usdc_account)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: vault token authority PDA.
    #[account(seeds = [AUTHORITY_SEED, vault.key().as_ref()], bump = vault.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, has_one = vault, has_one = owner)]
    pub request: Box<Account<'info, WithdrawRequest>>,
    /// CHECK: request owner (rent refund on close); pinned by `has_one`.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub usdc_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    pub caller: Signer<'info>,
    #[account(mut, has_one = usdc_mint, has_one = usdc_account)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: vault token authority PDA.
    #[account(seeds = [AUTHORITY_SEED, vault.key().as_ref()], bump = vault.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, has_one = vault, has_one = owner)]
    pub request: Box<Account<'info, WithdrawRequest>>,
    /// CHECK: request owner; pinned by `has_one`.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub usdc_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Cross<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, has_one = keeper @ VaultError::NotKeeper, has_one = usdc_account)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, has_one = vault)]
    pub request: Box<Account<'info, WithdrawRequest>>,
    /// CHECK: key pinned by `has_one`; read for the free USDC balance.
    pub usdc_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct KeeperSwap<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, has_one = keeper @ VaultError::NotKeeper)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: vault token authority PDA; signs the swap CPI.
    #[account(seeds = [AUTHORITY_SEED, vault.key().as_ref()], bump = vault.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: checked against the compile-time venue allowlist.
    #[account(executable)]
    pub swap_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FulfillSwap<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, has_one = keeper @ VaultError::NotKeeper)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: vault token authority PDA; signs the swap CPI.
    #[account(seeds = [AUTHORITY_SEED, vault.key().as_ref()], bump = vault.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, has_one = vault)]
    pub request: Box<Account<'info, WithdrawRequest>>,
    /// CHECK: checked against the compile-time venue allowlist.
    #[account(executable)]
    pub swap_program: UncheckedAccount<'info>,
}

// ---------- events / errors ----------

#[event]
pub struct PricesUpdated {
    pub vault: Pubkey,
    pub prices: Vec<u64>,
    pub at: i64,
    pub admin_override: bool,
}

#[event]
pub struct PausedSet {
    pub vault: Pubkey,
    pub paused: bool,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub usdc_in: u64,
    pub fee: u64,
    pub shares_out: u64,
    pub nav_before: u64,
    pub supply_before: u64,
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub shares: u64,
    pub usdc_out: u64,
}

#[event]
pub struct Requested {
    pub vault: Pubkey,
    pub request: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub usdc: u64,
    pub in_kind_now: bool,
    pub admin_forced: bool,
}

#[event]
pub struct Crossed {
    pub vault: Pubkey,
    pub request: Pubkey,
    pub leg: u8,
    pub amount: u64,
    pub usdc: u64,
}

#[event]
pub struct Claimed {
    pub vault: Pubkey,
    pub request: Pubkey,
    pub owner: Pubkey,
    pub legs: Vec<u8>,
    pub usdc: u64,
}

#[event]
pub struct Settled {
    pub vault: Pubkey,
    pub request: Pubkey,
    pub owner: Pubkey,
    pub usdc: u64,
}

#[event]
pub struct Swapped {
    pub vault: Pubkey,
    pub in_leg: u8,
    pub out_leg: u8,
    pub spent: u64,
    pub received: u64,
    pub request: Option<Pubkey>,
}

#[error_code]
pub enum VaultError {
    #[msg("Index id must be 1-64 bytes and hash to the index seed")]
    InvalidIndexId,
    #[msg("Invalid leg set")]
    InvalidLegs,
    #[msg("Duplicate leg mint")]
    DuplicateLeg,
    #[msg("Weights must be positive and sum to 10000 bps")]
    InvalidWeights,
    #[msg("Invalid vault configuration")]
    InvalidConfig,
    #[msg("Swap program is not allowed")]
    SwapProgramNotAllowed,
    #[msg("Account does not match the vault leg")]
    LegAccountMismatch,
    #[msg("User token account does not match")]
    UserAccountMismatch,
    #[msg("Not a token account")]
    NotATokenAccount,
    #[msg("Vault token accounts must be owned by the authority PDA with no delegate or close authority")]
    VaultAccountAuthority,
    #[msg("Only the vault keeper may do this")]
    NotKeeper,
    #[msg("Prices must be positive, one per leg")]
    InvalidPrices,
    #[msg("Posted prices are stale")]
    StalePrices,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Vault value is zero with outstanding shares")]
    ZeroNav,
    #[msg("Deposit is too small to mint a share unit")]
    ZeroShares,
    #[msg("Slippage bound exceeded")]
    SlippageExceeded,
    #[msg("Not enough shares")]
    InsufficientShares,
    #[msg("Vault leg accounts are missing")]
    MissingLegAccounts,
    #[msg("USDC buffer is short; use request_withdraw")]
    UsdcBufferShort,
    #[msg("Invalid swap legs")]
    InvalidSwapLegs,
    #[msg("Swap reduced a vault account it was not allowed to spend")]
    SwapDrainedAccount,
    #[msg("Swap produced an invalid balance delta")]
    SwapInvalidDelta,
    #[msg("Swap spent more than amount_in")]
    SwapOverspent,
    #[msg("Swap output is below the posted-price slippage bound")]
    SwapPriceBound,
    #[msg("Swap spent amounts reserved for withdraw requests")]
    SwapSpentReserved,
    #[msg("Buying this leg would take the USDC buffer below its floor")]
    BufferBreached,
    #[msg("The keeper cannot deposit")]
    KeeperCannotDeposit,
    #[msg("Marks must be at least one slot old")]
    MarksTooNew,
    #[msg("Deposit is above the per-deposit cap")]
    DepositAboveCap,
    #[msg("The vault is paused")]
    Paused,
    #[msg("A mark moved more than the allowed band; admin override required")]
    PriceMoveTooLarge,
    #[msg("This request is not claimable by this signer yet")]
    NotClaimable,
    #[msg("Request still has unconverted legs")]
    RequestNotConverted,
    #[msg("USDC total is below the request's min_usdc; claim in kind instead")]
    MinUsdcUnmet,
    #[msg("Math overflow")]
    MathOverflow,
}
