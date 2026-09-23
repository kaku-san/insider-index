//! Devnet/test-only fixed-price swap venue. Stands in for Jupiter, which has no devnet
//! deployment, so the NAV vault's `keeper_swap` CPI path can be exercised end to end.
//! NEVER a mainnet venue: the NAV vault only allows this program id in `devnet` builds.
#![allow(unexpected_cfgs)]
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// sha256("global:swap")[..8]
pub const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_LEN: usize = 32 + 32 + 32 + 8 + 1 + 1 + 1;

pub struct Pool {
    pub admin: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    /// Quote raw units per 10^base_decimals base raw units.
    pub price: u64,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub bump: u8,
}

impl Pool {
    fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < POOL_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Pool {
            admin: Pubkey::new_from_array(data[0..32].try_into().unwrap()),
            base_mint: Pubkey::new_from_array(data[32..64].try_into().unwrap()),
            quote_mint: Pubkey::new_from_array(data[64..96].try_into().unwrap()),
            price: u64::from_le_bytes(data[96..104].try_into().unwrap()),
            base_decimals: data[104],
            quote_decimals: data[105],
            bump: data[106],
        })
    }
    fn pack(&self, data: &mut [u8]) {
        data[0..32].copy_from_slice(self.admin.as_ref());
        data[32..64].copy_from_slice(self.base_mint.as_ref());
        data[64..96].copy_from_slice(self.quote_mint.as_ref());
        data[96..104].copy_from_slice(&self.price.to_le_bytes());
        data[104] = self.base_decimals;
        data[105] = self.quote_decimals;
        data[106] = self.bump;
    }
}

fn u64_at(data: &[u8], at: usize) -> Result<u64, ProgramError> {
    data.get(at..at + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap())).ok_or(ProgramError::InvalidInstructionData)
}

fn mint_decimals(info: &AccountInfo) -> Result<u8, ProgramError> {
    let data = info.try_borrow_data()?;
    data.get(44).copied().ok_or(ProgramError::InvalidAccountData)
}

#[allow(clippy::too_many_arguments)]
fn transfer_checked<'a>(program: &AccountInfo<'a>, from: &AccountInfo<'a>, mint: &AccountInfo<'a>, to: &AccountInfo<'a>, authority: &AccountInfo<'a>, amount: u64, decimals: u8, seeds: Option<&[&[u8]]>) -> ProgramResult {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let ix = Instruction {
        program_id: *program.key,
        accounts: vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    let infos = [from.clone(), mint.clone(), to.clone(), authority.clone(), program.clone()];
    match seeds {
        Some(s) => invoke_signed(&ix, &infos, &[s]),
        None => invoke(&ix, &infos),
    }
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() >= 8 && data[..8] == SWAP_DISCRIMINATOR {
        return swap(program_id, accounts, &data[8..]);
    }
    match data.first() {
        // InitPool { price: u64 } : [payer(s,w), pool(w), base_mint, quote_mint, system_program]
        Some(0) => {
            let it = &mut accounts.iter();
            let payer = next_account_info(it)?;
            let pool = next_account_info(it)?;
            let base_mint = next_account_info(it)?;
            let quote_mint = next_account_info(it)?;
            let system = next_account_info(it)?;
            if !payer.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            let (expected, bump) = Pubkey::find_program_address(&[POOL_SEED, base_mint.key.as_ref(), quote_mint.key.as_ref()], program_id);
            if expected != *pool.key {
                return Err(ProgramError::InvalidSeeds);
            }
            let price = u64_at(data, 1)?;
            invoke_signed(
                &system_instruction::create_account(payer.key, pool.key, Rent::get()?.minimum_balance(POOL_LEN), POOL_LEN as u64, program_id),
                &[payer.clone(), pool.clone(), system.clone()],
                &[&[POOL_SEED, base_mint.key.as_ref(), quote_mint.key.as_ref(), &[bump]]],
            )?;
            let state = Pool {
                admin: *payer.key,
                base_mint: *base_mint.key,
                quote_mint: *quote_mint.key,
                price,
                base_decimals: mint_decimals(base_mint)?,
                quote_decimals: mint_decimals(quote_mint)?,
                bump,
            };
            state.pack(&mut pool.try_borrow_mut_data()?);
            Ok(())
        }
        // SetPrice { price: u64 } : [admin(s), pool(w)]
        Some(1) => {
            let it = &mut accounts.iter();
            let admin = next_account_info(it)?;
            let pool = next_account_info(it)?;
            if pool.owner != program_id {
                return Err(ProgramError::IncorrectProgramId);
            }
            let mut state = Pool::unpack(&pool.try_borrow_data()?)?;
            if !admin.is_signer || *admin.key != state.admin {
                return Err(ProgramError::MissingRequiredSignature);
            }
            state.price = u64_at(data, 1)?;
            state.pack(&mut pool.try_borrow_mut_data()?);
            Ok(())
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// swap { amount_in: u64, min_out: u64 }
/// [user_authority(s), pool, user_src(w), user_dst(w), pool_src(w), pool_dst(w), mint_in, mint_out, token_program_in, token_program_out]
fn swap(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let user = next_account_info(it)?;
    let pool = next_account_info(it)?;
    let user_src = next_account_info(it)?;
    let user_dst = next_account_info(it)?;
    let pool_src = next_account_info(it)?;
    let pool_dst = next_account_info(it)?;
    let mint_in = next_account_info(it)?;
    let mint_out = next_account_info(it)?;
    let program_in = next_account_info(it)?;
    let program_out = next_account_info(it)?;
    if pool.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let state = Pool::unpack(&pool.try_borrow_data()?)?;
    let amount_in = u64_at(args, 0)?;
    let min_out = u64_at(args, 8)?;
    let base_scale = 10u128.pow(state.base_decimals as u32);
    let (out, in_dec, out_dec) = if *mint_in.key == state.base_mint && *mint_out.key == state.quote_mint {
        ((amount_in as u128) * (state.price as u128) / base_scale, state.base_decimals, state.quote_decimals)
    } else if *mint_in.key == state.quote_mint && *mint_out.key == state.base_mint {
        ((amount_in as u128) * base_scale / (state.price as u128), state.quote_decimals, state.base_decimals)
    } else {
        return Err(ProgramError::InvalidArgument);
    };
    let out = u64::try_from(out).map_err(|_| ProgramError::ArithmeticOverflow)?;
    if out < min_out || out == 0 {
        msg!("mock-swap: out {} below min {}", out, min_out);
        return Err(ProgramError::Custom(6001));
    }
    transfer_checked(program_in, user_src, mint_in, pool_dst, user, amount_in, in_dec, None)?;
    let seeds: &[&[u8]] = &[POOL_SEED, state.base_mint.as_ref(), state.quote_mint.as_ref(), &[state.bump]];
    transfer_checked(program_out, pool_src, mint_out, user_dst, pool, out, out_dec, Some(seeds))?;
    msg!("mock-swap: in {} out {}", amount_in, out);
    Ok(())
}
