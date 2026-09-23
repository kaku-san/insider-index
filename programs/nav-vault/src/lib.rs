//! InsiderIndex NAV vault (ERC-4626-style, unaudited hackathon program).
//!
//! - `deposit`: ONE user signature. USDC moves into the vault and shares mint at the current
//!   vault value (USDC + sum(leg balance x keeper-posted price)) in the same instruction.
//!   First deposit into an empty share supply mints 1:1.
//! - `withdraw`: ONE user signature. Burns shares and pays USDC from the vault buffer. When the
//!   buffer cannot cover the NAV value of the shares, the user instead receives the exact
//!   pro-rata slice of every vault token account (USDC + each leg).
//! - `withdraw_in_kind`: price-independent pro-rata exit, available even when prices are stale.
//! - `keeper_swap`: keeper-signed CPI into a compile-time venue allowlist (Jupiter V6 exact-in
//!   routes, Raydium CLMM swap_v2; plus a mock venue only in `devnet` builds) that may only move value between the vault's own token accounts of allowed mints,
//!   bounded by `min_out` and a posted-price slippage bound. Share supply, authorities and
//!   untouched balances are re-checked after the CPI.
//! - `update_prices`: keeper-posted prices with an on-chain staleness bound. Deposits and the
//!   priced withdraw refuse stale prices.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hash,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};
use anchor_spl::token_interface::{self, TransferChecked};

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
/// Inflation-attack offset (virtual 1 share / 1 USDC). Keeps the first deposit 1:1.
pub const VIRTUAL_SHARES: u128 = 1_000_000;
pub const VIRTUAL_ASSETS: u128 = 1_000_000;
pub const MAX_LEGS: usize = 16;
pub const MAX_INDEX_ID_LEN: usize = 64;
pub const BPS: u64 = 10_000;
/// Leg selector meaning "the vault USDC account" in `keeper_swap`.
pub const USDC_LEG: u8 = u8::MAX;
pub const SHARE_DECIMALS: u8 = 6;
/// Posted prices are USDC raw units per 10^decimals raw leg units (i.e. dollars x 1e6 per whole token).
pub const USDC_PRICE: u64 = 1_000_000;
/// Hard caps on admin-set economics (captain defaults: 25 bps entry fee, 500 bps USDC buffer).
pub const MAX_ENTRY_FEE_BPS: u16 = 100;
pub const MAX_BUFFER_BPS: u16 = 5_000;

pub const VAULT_SEED: &[u8] = b"nav_vault";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
pub const SHARES_SEED: &[u8] = b"shares";

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
        require!(args.max_price_age_secs > 0, VaultError::InvalidConfig);
        require!(args.max_slippage_bps < BPS as u16, VaultError::InvalidConfig);
        require!(args.entry_fee_bps <= MAX_ENTRY_FEE_BPS, VaultError::InvalidConfig);
        require!(args.buffer_bps <= MAX_BUFFER_BPS, VaultError::InvalidConfig);
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
            legs.push(Leg {
                mint: mint.key(),
                account: account.key(),
                token_program,
                decimals,
                weight_bps: args.weights_bps[i],
                price: 0,
            });
        }

        let vault = &mut ctx.accounts.vault;
        vault.admin = ctx.accounts.admin.key();
        vault.keeper = args.keeper;
        vault.index_seed = args.index_seed;
        vault.index_id = args.index_id;
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.usdc_mint = usdc_mint;
        vault.usdc_account = ctx.accounts.usdc_account.key();
        vault.max_price_age_secs = args.max_price_age_secs;
        vault.max_slippage_bps = args.max_slippage_bps;
        vault.entry_fee_bps = args.entry_fee_bps;
        vault.buffer_bps = args.buffer_bps;
        vault.fee_account = ctx.accounts.fee_account.key();
        vault.prices_updated_at = 0;
        vault.prices_updated_slot = 0;
        vault.bump = ctx.bumps.vault;
        vault.authority_bump = ctx.bumps.authority;
        vault.mint_authority_bump = ctx.bumps.mint_authority;
        vault.legs = legs;
        Ok(())
    }

    pub fn set_keeper(ctx: Context<SetKeeper>, keeper: Pubkey) -> Result<()> {
        ctx.accounts.vault.keeper = keeper;
        Ok(())
    }

    /// Client convenience only: the table is never trusted on chain (every account is re-checked).
    pub fn set_lookup_table(ctx: Context<SetKeeper>, lookup_table: Pubkey) -> Result<()> {
        ctx.accounts.vault.lookup_table = lookup_table;
        Ok(())
    }

    pub fn update_prices(ctx: Context<UpdatePrices>, prices: Vec<u64>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(prices.len() == vault.legs.len(), VaultError::InvalidPrices);
        require!(prices.iter().all(|p| *p > 0), VaultError::InvalidPrices);
        for (leg, price) in vault.legs.iter_mut().zip(prices.iter()) {
            leg.price = *price;
        }
        let clock = Clock::get()?;
        vault.prices_updated_at = clock.unix_timestamp;
        vault.prices_updated_slot = clock.slot;
        emit!(PricesUpdated { vault: vault.key(), prices, at: vault.prices_updated_at });
        Ok(())
    }

    pub fn deposit<'info>(ctx: Context<'_, '_, 'info, 'info, Deposit<'info>>, usdc_amount: u64, min_shares: u64) -> Result<()> {
        require!(usdc_amount > 0, VaultError::ZeroAmount);
        let vault = &ctx.accounts.vault;
        require_keys_neq!(ctx.accounts.user.key(), vault.keeper, VaultError::KeeperCannotDeposit);
        assert_fresh_prices(vault)?;
        // Marks must be at least one slot old: the keeper cannot post a mark and trade on it in the same slot.
        require!(Clock::get()?.slot > vault.prices_updated_slot, VaultError::MarksTooNew);
        let n = vault.legs.len();
        require!(ctx.remaining_accounts.len() >= n, VaultError::MissingLegAccounts);
        let nav = vault_nav(vault, ctx.accounts.usdc_account.amount, &ctx.remaining_accounts[..n])?;
        let supply = ctx.accounts.share_mint.supply;
        // ERC-4626 with a virtual offset: first deposit into an empty vault mints 1:1, and a
        // donation cannot inflate the share price enough to round the next depositor to zero.
        // Entry fee (rounded up) is paid out of the deposit so existing holders do not fund the
        // keeper's later trade costs; shares are minted on the net amount only.
        let fee = to_u64(((usdc_amount as u128) * (vault.entry_fee_bps as u128)).div_ceil(BPS as u128))?;
        let net = usdc_amount.checked_sub(fee).ok_or(error!(VaultError::MathOverflow))?;
        let shares = to_u64((net as u128) * (supply as u128 + VIRTUAL_SHARES) / (nav + VIRTUAL_ASSETS))?;
        require!(shares > 0, VaultError::ZeroShares);
        require!(shares >= min_shares, VaultError::SlippageExceeded);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.usdc_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            net,
            ctx.accounts.usdc_mint.decimals,
        )?;
        if fee > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.user_usdc.to_account_info(),
                        mint: ctx.accounts.usdc_mint.to_account_info(),
                        to: ctx.accounts.fee_account.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                fee,
                ctx.accounts.usdc_mint.decimals,
            )?;
        }
        let vault_key = vault.key();
        let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, vault_key.as_ref(), &[vault.mint_authority_bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_shares.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            shares,
        )?;
        emit!(Deposited {
            vault: vault_key,
            user: ctx.accounts.user.key(),
            usdc_in: usdc_amount,
            fee,
            shares_out: shares,
            nav_before: to_u64(nav)?,
            supply_before: supply,
        });
        Ok(())
    }

    /// Priced exit: USDC from the buffer when it covers the NAV value of `shares`, otherwise the
    /// exact pro-rata in-kind slice (requires the optional in-kind account groups).
    pub fn withdraw<'info>(ctx: Context<'_, '_, 'info, 'info, Withdraw<'info>>, shares: u64, min_usdc: u64) -> Result<()> {
        require!(shares > 0, VaultError::ZeroAmount);
        let vault = &ctx.accounts.vault;
        assert_fresh_prices(vault)?;
        let n = vault.legs.len();
        require!(ctx.remaining_accounts.len() >= n, VaultError::MissingLegAccounts);
        let supply = ctx.accounts.share_mint.supply;
        require!(shares <= supply, VaultError::InsufficientShares);
        let buffer = ctx.accounts.usdc_account.amount;
        let nav = vault_nav(vault, buffer, &ctx.remaining_accounts[..n])?;
        let value = to_u64((shares as u128) * (nav + VIRTUAL_ASSETS) / (supply as u128 + VIRTUAL_SHARES))?;
        // The NAV value of the shares protects the user in both paths (in-kind slices are worth
        // exactly this at posted prices).
        require!(value >= min_usdc, VaultError::SlippageExceeded);

        if buffer >= value {
            burn_shares(&ctx, shares)?;
            transfer_from_vault(
                &ctx.accounts.token_program.to_account_info(),
                &ctx.accounts.usdc_account.to_account_info(),
                &ctx.accounts.usdc_mint.to_account_info(),
                &ctx.accounts.user_usdc.to_account_info(),
                &ctx.accounts.authority.to_account_info(),
                vault,
                value,
                ctx.accounts.usdc_mint.decimals,
            )?;
            emit!(Withdrawn { vault: vault.key(), user: ctx.accounts.user.key(), shares, path: WithdrawPath::Usdc, usdc_out: value, value });
            return Ok(());
        }
        require!(ctx.remaining_accounts.len() >= n * 4, VaultError::UsdcBufferShort);
        let usdc_out = pay_in_kind(&ctx, shares, supply, buffer)?;
        burn_shares(&ctx, shares)?;
        emit!(Withdrawn { vault: vault.key(), user: ctx.accounts.user.key(), shares, path: WithdrawPath::InKind, usdc_out, value });
        Ok(())
    }

    /// Price-independent pro-rata exit. Always available (no keeper, no fresh price needed).
    pub fn withdraw_in_kind<'info>(ctx: Context<'_, '_, 'info, 'info, Withdraw<'info>>, shares: u64) -> Result<()> {
        require!(shares > 0, VaultError::ZeroAmount);
        let n = ctx.accounts.vault.legs.len();
        require!(ctx.remaining_accounts.len() >= n * 4, VaultError::MissingLegAccounts);
        let supply = ctx.accounts.share_mint.supply;
        require!(shares <= supply, VaultError::InsufficientShares);
        let buffer = ctx.accounts.usdc_account.amount;
        let usdc_out = pay_in_kind(&ctx, shares, supply, buffer)?;
        burn_shares(&ctx, shares)?;
        emit!(Withdrawn { vault: ctx.accounts.vault.key(), user: ctx.accounts.user.key(), shares, path: WithdrawPath::InKind, usdc_out, value: 0 });
        Ok(())
    }

    /// remaining_accounts = [vault leg token accounts x N (vault order)] ++ [swap instruction accounts].
    pub fn keeper_swap<'info>(ctx: Context<'_, '_, 'info, 'info, KeeperSwap<'info>>, args: KeeperSwapArgs) -> Result<()> {
        let vault = &ctx.accounts.vault;
        let n = vault.legs.len();
        require!(args.in_leg != args.out_leg, VaultError::InvalidSwapLegs);
        require!(args.in_leg == USDC_LEG || (args.in_leg as usize) < n, VaultError::InvalidSwapLegs);
        require!(args.out_leg == USDC_LEG || (args.out_leg as usize) < n, VaultError::InvalidSwapLegs);
        require!(args.amount_in > 0, VaultError::ZeroAmount);
        assert_allowed_swap(&ctx.accounts.swap_program.key(), &args.data)?;
        assert_fresh_prices(vault)?;
        require!(ctx.remaining_accounts.len() >= n, VaultError::MissingLegAccounts);
        let (leg_accounts, swap_accounts) = ctx.remaining_accounts.split_at(n);
        let usdc_info = ctx.accounts.usdc_account.to_account_info();
        let authority = ctx.accounts.authority.key();

        let read_all = |check_clean: bool| -> Result<Vec<u64>> {
            let mut out = Vec::with_capacity(n + 1);
            if check_clean {
                assert_clean_vault_account(&usdc_info, &authority)?;
            }
            out.push(token_amount(&usdc_info)?);
            for (leg, info) in vault.legs.iter().zip(leg_accounts.iter()) {
                require_keys_eq!(info.key(), leg.account, VaultError::LegAccountMismatch);
                if check_clean {
                    assert_clean_vault_account(info, &authority)?;
                }
                out.push(token_amount(info)?);
            }
            Ok(out)
        };
        let before = read_all(false)?;
        let supply_before = ctx.accounts.share_mint.supply;

        let metas: Vec<AccountMeta> = swap_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: a.key(),
                is_signer: a.is_signer || a.key() == authority,
                is_writable: a.is_writable,
            })
            .collect();
        let ix = Instruction { program_id: ctx.accounts.swap_program.key(), accounts: metas, data: args.data.clone() };
        let mut infos: Vec<AccountInfo<'info>> = swap_accounts.to_vec();
        infos.push(ctx.accounts.authority.to_account_info());
        infos.push(ctx.accounts.swap_program.to_account_info());
        let vault_key = vault.key();
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, vault_key.as_ref(), &[vault.authority_bump]];
        invoke_signed(&ix, &infos, &[seeds])?;

        let after = read_all(true)?;
        ctx.accounts.share_mint.reload()?;
        require!(ctx.accounts.share_mint.supply == supply_before, VaultError::SwapTouchedShares);
        let slot = |leg: u8| if leg == USDC_LEG { 0usize } else { leg as usize + 1 };
        let (i_in, i_out) = (slot(args.in_leg), slot(args.out_leg));
        for i in 0..=n {
            if i != i_in {
                require!(after[i] >= before[i], VaultError::SwapDrainedAccount);
            }
        }
        require!(after[i_in] <= before[i_in], VaultError::SwapInvalidDelta);
        let spent = before[i_in] - after[i_in];
        require!(spent <= args.amount_in, VaultError::SwapOverspent);
        let received = after[i_out] - before[i_out];
        require!(received >= args.min_out, VaultError::SlippageExceeded);
        let (value_in, value_out) = (leg_value(vault, args.in_leg, spent)?, leg_value(vault, args.out_leg, received)?);
        require!(
            value_out * (BPS as u128) >= value_in * ((BPS - vault.max_slippage_bps as u64) as u128),
            VaultError::SwapPriceBound
        );
        if args.in_leg == USDC_LEG && vault.buffer_bps > 0 {
            // Buying a leg may not take the USDC buffer below buffer_bps of post-swap NAV.
            let mut nav_after = after[0] as u128;
            for i in 0..n {
                nav_after += leg_value(vault, i as u8, after[i + 1])?;
            }
            require!((after[0] as u128) * (BPS as u128) >= nav_after * (vault.buffer_bps as u128), VaultError::BufferBreached);
        }
        emit!(Swapped { vault: vault_key, in_leg: args.in_leg, out_leg: args.out_leg, spent, received });
        Ok(())
    }
}

// ---------- helpers ----------

fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(VaultError::MathOverflow))
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
    require!(data[45] == 1, VaultError::InvalidLegs); // is_initialized
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

fn leg_value(vault: &Vault, leg: u8, amount: u64) -> Result<u128> {
    if leg == USDC_LEG {
        return Ok(amount as u128);
    }
    let leg = &vault.legs[leg as usize];
    Ok((amount as u128) * (leg.price as u128) / 10u128.pow(leg.decimals as u32))
}

/// NAV in USDC raw units: USDC buffer + sum(leg balance x posted price).
fn vault_nav(vault: &Vault, usdc_balance: u64, leg_accounts: &[AccountInfo]) -> Result<u128> {
    let mut total = usdc_balance as u128;
    for (i, leg) in vault.legs.iter().enumerate() {
        let info = &leg_accounts[i];
        require_keys_eq!(info.key(), leg.account, VaultError::LegAccountMismatch);
        require_keys_eq!(*info.owner, leg.token_program, VaultError::LegAccountMismatch);
        total += leg_value(vault, i as u8, token_amount(info)?)?;
    }
    Ok(total)
}

fn burn_shares(ctx: &Context<'_, '_, '_, '_, Withdraw<'_>>, shares: u64) -> Result<()> {
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.user_shares.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )
}

#[allow(clippy::too_many_arguments)]
fn transfer_from_vault<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    vault: &Account<'info, Vault>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let vault_key = vault.key();
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, vault_key.as_ref(), &[vault.authority_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.clone(),
            TransferChecked { from: from.clone(), mint: mint.clone(), to: to.clone(), authority: authority.clone() },
            &[seeds],
        ),
        amount,
        decimals,
    )
}

/// Pays floor(balance x shares / supply) of the USDC buffer and of every leg. Returns the USDC paid.
/// remaining = [vault leg accounts x N] ++ [(leg mint, user leg account, leg token program) x N].
fn pay_in_kind<'info>(ctx: &Context<'_, '_, 'info, 'info, Withdraw<'info>>, shares: u64, supply: u64, buffer: u64) -> Result<u64> {
    let vault = &ctx.accounts.vault;
    let n = vault.legs.len();
    let rem = ctx.remaining_accounts;
    let usdc_out = to_u64((buffer as u128) * (shares as u128) / (supply as u128))?;
    transfer_from_vault(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.usdc_account.to_account_info(),
        &ctx.accounts.usdc_mint.to_account_info(),
        &ctx.accounts.user_usdc.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        vault,
        usdc_out,
        ctx.accounts.usdc_mint.decimals,
    )?;
    let user = ctx.accounts.user.key();
    for (i, leg) in vault.legs.iter().enumerate() {
        let vault_leg = &rem[i];
        let mint = &rem[n + 3 * i];
        let user_leg = &rem[n + 3 * i + 1];
        let program = &rem[n + 3 * i + 2];
        require_keys_eq!(vault_leg.key(), leg.account, VaultError::LegAccountMismatch);
        require_keys_eq!(mint.key(), leg.mint, VaultError::LegAccountMismatch);
        require_keys_eq!(program.key(), leg.token_program, VaultError::LegAccountMismatch);
        require_keys_eq!(token_mint(user_leg)?, leg.mint, VaultError::UserAccountMismatch);
        require_keys_eq!(token_owner(user_leg)?, user, VaultError::UserAccountMismatch);
        let amount = to_u64((token_amount(vault_leg)? as u128) * (shares as u128) / (supply as u128))?;
        transfer_from_vault(program, vault_leg, mint, user_leg, &ctx.accounts.authority.to_account_info(), vault, amount, leg.decimals)?;
    }
    Ok(usdc_out)
}

// ---------- accounts ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitVaultArgs {
    pub index_seed: [u8; 32],
    pub index_id: String,
    pub keeper: Pubkey,
    pub max_price_age_secs: u32,
    pub max_slippage_bps: u16,
    pub entry_fee_bps: u16,
    pub buffer_bps: u16,
    pub weights_bps: Vec<u16>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct KeeperSwapArgs {
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
    pub max_price_age_secs: u32,
    pub max_slippage_bps: u16,
    pub prices_updated_at: i64,
    pub prices_updated_slot: u64,
    /// Entry fee in bps of the deposited USDC, paid to `fee_account` in the deposit instruction.
    pub entry_fee_bps: u16,
    /// Minimum USDC share of NAV the keeper must leave after buying a leg (exit buffer).
    pub buffer_bps: u16,
    pub fee_account: Pubkey,
    /// Address lookup table clients use to fit the one-signature exit into a single v0 transaction.
    pub lookup_table: Pubkey,
    pub bump: u8,
    pub authority_bump: u8,
    pub mint_authority_bump: u8,
    #[max_len(16)]
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
    /// CHECK: PDA that is the only share mint authority (never passed to swap CPIs).
    #[account(seeds = [MINT_AUTHORITY_SEED, vault.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(init, payer = admin, seeds = [SHARES_SEED, vault.key().as_ref()], bump, mint::decimals = SHARE_DECIMALS, mint::authority = mint_authority, mint::token_program = token_program)]
    pub share_mint: Box<Account<'info, Mint>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(constraint = usdc_account.mint == usdc_mint.key() @ VaultError::LegAccountMismatch)]
    pub usdc_account: Box<Account<'info, TokenAccount>>,
    /// USDC account that receives the entry fee (keeper trade-cost budget). Must not be a vault account.
    #[account(constraint = fee_account.mint == usdc_mint.key() @ VaultError::LegAccountMismatch, constraint = fee_account.key() != usdc_account.key() @ VaultError::InvalidConfig)]
    pub fee_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetKeeper<'info> {
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
    #[account(has_one = share_mint, has_one = usdc_mint, has_one = usdc_account)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: share mint authority PDA.
    #[account(seeds = [MINT_AUTHORITY_SEED, vault.key().as_ref()], bump = vault.mint_authority_bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub share_mint: Box<Account<'info, Mint>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub usdc_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = share_mint, token::authority = user)]
    pub user_shares: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = vault.fee_account @ VaultError::InvalidConfig)]
    pub fee_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
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
    pub share_mint: Box<Account<'info, Mint>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub usdc_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = share_mint, token::authority = user)]
    pub user_shares: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct KeeperSwap<'info> {
    pub keeper: Signer<'info>,
    #[account(has_one = keeper @ VaultError::NotKeeper, has_one = share_mint, has_one = usdc_account)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: vault token authority PDA; signs the swap CPI.
    #[account(seeds = [AUTHORITY_SEED, vault.key().as_ref()], bump = vault.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub share_mint: Box<Account<'info, Mint>>,
    /// CHECK: key pinned by `has_one`; parsed manually before/after the CPI.
    #[account(mut)]
    pub usdc_account: UncheckedAccount<'info>,
    /// CHECK: checked against the compile-time venue allowlist in `assert_allowed_swap`.
    #[account(executable)]
    pub swap_program: UncheckedAccount<'info>,
}

// ---------- events / errors ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum WithdrawPath {
    Usdc,
    InKind,
}

#[event]
pub struct PricesUpdated {
    pub vault: Pubkey,
    pub prices: Vec<u64>,
    pub at: i64,
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
    pub path: WithdrawPath,
    pub usdc_out: u64,
    pub value: u64,
}

#[event]
pub struct Swapped {
    pub vault: Pubkey,
    pub in_leg: u8,
    pub out_leg: u8,
    pub spent: u64,
    pub received: u64,
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
    #[msg("USDC buffer is short; include in-kind accounts to receive the pro-rata basket")]
    UsdcBufferShort,
    #[msg("Invalid swap legs")]
    InvalidSwapLegs,
    #[msg("Swap changed share supply")]
    SwapTouchedShares,
    #[msg("Swap reduced a vault account it was not allowed to spend")]
    SwapDrainedAccount,
    #[msg("Swap produced an invalid balance delta")]
    SwapInvalidDelta,
    #[msg("Swap spent more than amount_in")]
    SwapOverspent,
    #[msg("Swap output is below the posted-price slippage bound")]
    SwapPriceBound,
    #[msg("Buying this leg would take the USDC buffer below its floor")]
    BufferBreached,
    #[msg("The keeper cannot deposit")]
    KeeperCannotDeposit,
    #[msg("Marks must be at least one slot old")]
    MarksTooNew,
    #[msg("Math overflow")]
    MathOverflow,
}
