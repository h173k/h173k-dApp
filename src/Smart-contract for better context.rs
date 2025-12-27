use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, CloseAccount, Mint, Token, TokenAccount, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use sha2::{Digest, Sha256};

declare_id!("pLEzeCQ8t7oz2YGzZmqz4a1mXNhhE3mJC89GSveijrG");

pub const TOKEN_MINT: Pubkey = pubkey!("DcAwQFCWCLjbaFa2j67pXx4S9Caeo6YkdZURmAsLkZTT");

#[program]
pub mod h173k_escrow_v7 {
    use super::*;

    pub const MAX_OFFERS: usize = 50;

    /// Initialize buyer index
    pub fn initialize_buyer_index(ctx: Context<InitializeBuyerIndex>) -> Result<()> {
        let buyer_index = &mut ctx.accounts.buyer_index;
        buyer_index.active_offers = Vec::new();
        buyer_index.next_nonce = 0;
        Ok(())
    }

    /// Initialize seller index
    pub fn initialize_seller_index(ctx: Context<InitializeSellerIndex>) -> Result<()> {
        let seller_index = &mut ctx.accounts.seller_index;
        seller_index.active_offers = Vec::new();
        Ok(())
    }

    pub fn create_offer(
        ctx: Context<CreateOffer>,
        amount: u64,
        code_hash: [u8; 32],
    ) -> Result<()> {
        require_gt!(amount, 0, ErrorCode::ZeroAmount);
        require!(ctx.accounts.buyer_index.active_offers.len() < MAX_OFFERS, ErrorCode::MaxOffersReached);
        require!(ctx.accounts.buyer_index.next_nonce < u64::MAX, ErrorCode::NonceOverflow);

        let offer = &mut ctx.accounts.offer;
        let offer_key = offer.key();

        offer.buyer = ctx.accounts.buyer.key();
        offer.buyer_vault = ctx.accounts.buyer_token.key();
        offer.seller = Pubkey::default();
        offer.seller_vault = Pubkey::default();
        offer.amount = amount;
        offer.code_hash = code_hash;
        offer.buyer_deposit = amount.checked_mul(2).ok_or(ErrorCode::Overflow)?;
        offer.seller_deposit = 0;
        offer.status = OfferStatus::PendingSeller;
        offer.nonce = ctx.accounts.buyer_index.next_nonce;
        offer.buyer_confirmed = false;
        offer.seller_confirmed = false;
        offer.is_closed = false;

        ctx.accounts.buyer_index.next_nonce += 1;
        ctx.accounts.buyer_index.active_offers.push(offer_key);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            offer.buyer_deposit,
        )?;

        emit!(OfferCreated {
            offer: offer_key,
            buyer: offer.buyer,
            amount,
            code_hash,
        });

        Ok(())
    }

    pub fn accept_offer(ctx: Context<AcceptOffer>, code: String) -> Result<()> {
        require!(code.len() <= 64, ErrorCode::CodeTooLong);
        let trimmed = code.trim();
        require!(!trimmed.is_empty(), ErrorCode::EmptyCode);

        let offer = &mut ctx.accounts.offer;
        let offer_key = offer.key();

        require!(offer.status == OfferStatus::PendingSeller, ErrorCode::InvalidState);
        require!(hash_code(trimmed, &offer_key) == offer.code_hash, ErrorCode::InvalidCode);
        require!(offer.seller == Pubkey::default(), ErrorCode::AlreadyAccepted);

        let required_deposit = offer.amount;
        require!(ctx.accounts.seller_token.amount >= required_deposit, ErrorCode::InsufficientDeposit);

        // Check seller_index limit
        require!(ctx.accounts.seller_index.active_offers.len() < MAX_OFFERS, ErrorCode::MaxOffersReached);

        offer.seller = ctx.accounts.seller.key();
        offer.seller_vault = ctx.accounts.seller_token.key();
        offer.seller_deposit = required_deposit;
        offer.status = OfferStatus::Locked;

        // Add to seller_index
        ctx.accounts.seller_index.active_offers.push(offer_key);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_token.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            required_deposit,
        )?;

        emit!(OfferLocked {
            offer: offer_key,
            seller: offer.seller,
        });

        Ok(())
    }

    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        let offer = &mut ctx.accounts.offer;
        let offer_key = offer.key();

        require!(offer.status == OfferStatus::PendingSeller, ErrorCode::InvalidState);
        require_keys_eq!(ctx.accounts.buyer.key(), offer.buyer, ErrorCode::Unauthorized);

        let seeds = &[b"escrow".as_ref(), offer_key.as_ref(), &[ctx.bumps.escrow_vault_authority]];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.buyer_token.to_account_info(),
                    authority: ctx.accounts.escrow_vault_authority.to_account_info(),
                },
                signer,
            ),
            offer.buyer_deposit,
        )?;

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_vault.to_account_info(),
                destination: ctx.accounts.buyer.to_account_info(),
                authority: ctx.accounts.escrow_vault_authority.to_account_info(),
            },
            signer,
        ))?;

        remove_offer_from_buyer_index(&mut ctx.accounts.buyer_index, offer_key)?;
        offer.status = OfferStatus::Cancelled;
        offer.is_closed = true;

        emit!(OfferCancelled { 
            offer: offer_key,
            buyer: offer.buyer,
        });
        Ok(())
    }

    pub fn confirm_completion(ctx: Context<ConfirmCompletion>) -> Result<()> {
        let offer = &mut ctx.accounts.offer;
        let offer_key = offer.key();

        require!(
            matches!(offer.status, OfferStatus::Locked | OfferStatus::BuyerConfirmed | OfferStatus::SellerConfirmed),
            ErrorCode::InvalidState
        );

        let is_buyer = ctx.accounts.user.key() == offer.buyer;
        let is_seller = ctx.accounts.user.key() == offer.seller;
        require!(is_buyer || is_seller, ErrorCode::Unauthorized);

        if is_buyer {
            require!(!offer.buyer_confirmed, ErrorCode::AlreadyConfirmed);
            offer.buyer_confirmed = true;
            emit!(BuyerConfirmed { offer: offer_key });
        } else {
            require!(!offer.seller_confirmed, ErrorCode::AlreadyConfirmed);
            offer.seller_confirmed = true;
            emit!(SellerConfirmed { offer: offer_key });
        }

        if offer.buyer_confirmed && offer.seller_confirmed {
            let seeds = &[b"escrow".as_ref(), offer_key.as_ref(), &[ctx.bumps.escrow_vault_authority]];
            let signer = &[&seeds[..]];

            // 1. seller gets amount
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.seller_token.to_account_info(),
                        authority: ctx.accounts.escrow_vault_authority.to_account_info(),
                    },
                    signer,
                ),
                offer.amount,
            )?;

            // 2. buyer gets refund
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.buyer_token.to_account_info(),
                        authority: ctx.accounts.escrow_vault_authority.to_account_info(),
                    },
                    signer,
                ),
                offer.amount,
            )?;

            // 3. seller gets deposit back
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.seller_token.to_account_info(),
                        authority: ctx.accounts.escrow_vault_authority.to_account_info(),
                    },
                    signer,
                ),
                offer.seller_deposit,
            )?;

            // 4. close vault
            token::close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.escrow_vault.to_account_info(),
                    destination: ctx.accounts.buyer.to_account_info(),
                    authority: ctx.accounts.escrow_vault_authority.to_account_info(),
                },
                signer,
            ))?;

            // 5. remove from both indexes
            remove_offer_from_buyer_index(&mut ctx.accounts.buyer_index, offer_key)?;
            remove_offer_from_seller_index(&mut ctx.accounts.seller_index, offer_key)?;

            offer.status = OfferStatus::Completed;
            offer.is_closed = true;
            emit!(OfferCompleted { offer: offer_key });
        } else if is_buyer {
            offer.status = OfferStatus::BuyerConfirmed;
        } else {
            offer.status = OfferStatus::SellerConfirmed;
        }

        Ok(())
    }

    pub fn burn_deposits(ctx: Context<BurnDeposits>) -> Result<()> {
        let offer = &mut ctx.accounts.offer;
        let offer_key = offer.key();

        require!(
            matches!(offer.status, OfferStatus::Locked | OfferStatus::BuyerConfirmed | OfferStatus::SellerConfirmed),
            ErrorCode::InvalidState
        );

        require!(
            ctx.accounts.signer.key() == offer.buyer || ctx.accounts.signer.key() == offer.seller,
            ErrorCode::Unauthorized
        );

        let seeds = &[b"escrow".as_ref(), offer_key.as_ref(), &[ctx.bumps.escrow_vault_authority]];
        let signer = &[&seeds[..]];

        let total_burn = offer.buyer_deposit
            .checked_add(offer.seller_deposit)
            .ok_or(ErrorCode::Overflow)?;

        require!(ctx.accounts.escrow_vault.amount >= total_burn, ErrorCode::InsufficientVaultBalance);

        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.escrow_vault_authority.to_account_info(),
                },
                signer,
            ),
            total_burn,
        )?;

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_vault.to_account_info(),
                destination: ctx.accounts.buyer.to_account_info(),
                authority: ctx.accounts.escrow_vault_authority.to_account_info(),
            },
            signer,
        ))?;

        // Remove from both indexes
        remove_offer_from_buyer_index(&mut ctx.accounts.buyer_index, offer_key)?;
        remove_offer_from_seller_index(&mut ctx.accounts.seller_index, offer_key)?;
        
        offer.status = OfferStatus::Burned;
        offer.is_closed = true;

        emit!(DepositsBurned { 
            offer: offer_key,
            buyer_amount: offer.buyer_deposit,
            seller_amount: offer.seller_deposit,
        });
        Ok(())
    }

    pub fn read_offer(ctx: Context<ReadOffer>, code: String) -> Result<()> {
        require!(code.len() <= 64, ErrorCode::CodeTooLong);
        let trimmed = code.trim();
        require!(!trimmed.is_empty(), ErrorCode::EmptyCode);

        let offer = &ctx.accounts.offer;
        let offer_key = offer.key();

        require!(hash_code(trimmed, &offer_key) == offer.code_hash, ErrorCode::InvalidCode);

        let is_buyer = ctx.accounts.user.key() == offer.buyer;
        let is_seller = ctx.accounts.user.key() == offer.seller || 
                       (offer.seller == Pubkey::default() && offer.status == OfferStatus::PendingSeller);
        
        require!(is_buyer || is_seller, ErrorCode::Unauthorized);

        emit!(OfferRead {
            offer: offer_key,
            buyer: offer.buyer,
            seller: offer.seller,
            amount: offer.amount,
            buyer_deposit: offer.buyer_deposit,
            seller_deposit: offer.seller_deposit,
            status: offer.status,
            buyer_confirmed: offer.buyer_confirmed,
            seller_confirmed: offer.seller_confirmed,
            is_closed: offer.is_closed,
        });

        Ok(())
    }
}

// === Helper functions ===

fn remove_offer_from_buyer_index(
    buyer_index: &mut Account<BuyerIndex>,
    offer_key: Pubkey,
) -> Result<()> {
    let pos = buyer_index.active_offers
        .iter()
        .position(|k| *k == offer_key)
        .ok_or(ErrorCode::InvalidRetain)?;
    buyer_index.active_offers.swap_remove(pos);
    Ok(())
}

fn remove_offer_from_seller_index(
    seller_index: &mut Account<SellerIndex>,
    offer_key: Pubkey,
) -> Result<()> {
    let pos = seller_index.active_offers
        .iter()
        .position(|k| *k == offer_key)
        .ok_or(ErrorCode::InvalidRetain)?;
    seller_index.active_offers.swap_remove(pos);
    Ok(())
}

fn hash_code(code: &str, offer_key: &Pubkey) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(offer_key.as_ref());
    hasher.update(code.as_bytes());
    let result = hasher.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&result);
    arr
}

// === Accounts ===

#[derive(Accounts)]
pub struct InitializeBuyerIndex<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        init,
        payer = buyer,
        space = 8 + 8 + 4 + 32 * MAX_OFFERS,
        seeds = [b"buyer_index", buyer.key().as_ref()],
        bump
    )]
    pub buyer_index: Account<'info, BuyerIndex>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeSellerIndex<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        init,
        payer = seller,
        space = 8 + 4 + 32 * MAX_OFFERS,
        seeds = [b"seller_index", seller.key().as_ref()],
        bump
    )]
    pub seller_index: Account<'info, SellerIndex>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, code_hash: [u8; 32])]
pub struct CreateOffer<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"buyer_index", buyer.key().as_ref()],
        bump
    )]
    pub buyer_index: Account<'info, BuyerIndex>,

    #[account(
        init,
        payer = buyer,
        space = 8 + 32*4 + 8*3 + 32 + 1 + 8 + 1 + 1 + 1 + 100,
        seeds = [b"offer", buyer.key().as_ref(), &buyer_index.next_nonce.to_le_bytes()],
        bump
    )]
    pub offer: Account<'info, Offer>,

    #[account(
        init,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = escrow_vault_authority
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(seeds = [b"escrow", offer.key().as_ref()], bump)]
    pub escrow_vault_authority: SystemAccount<'info>,

    #[account(constraint = mint.key() == TOKEN_MINT @ ErrorCode::InvalidMint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = buyer_token.owner == buyer.key() @ ErrorCode::Unauthorized,
        constraint = buyer_token.mint == mint.key() @ ErrorCode::InvalidMint
    )]
    pub buyer_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(mut)]
    pub offer: Account<'info, Offer>,

    #[account(
        mut,
        seeds = [b"seller_index", seller.key().as_ref()],
        bump
    )]
    pub seller_index: Account<'info, SellerIndex>,

    #[account(
        mut,
        constraint = seller_token.owner == seller.key() @ ErrorCode::Unauthorized,
        constraint = seller_token.mint == escrow_vault.mint @ ErrorCode::InvalidMint
    )]
    pub seller_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(seeds = [b"escrow", offer.key().as_ref()], bump)]
    pub escrow_vault_authority: SystemAccount<'info>,

    #[account(constraint = mint.key() == TOKEN_MINT @ ErrorCode::InvalidMint)]
    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub offer: Account<'info, Offer>,

    #[account(
        mut,
        constraint = buyer_token.mint == escrow_vault.mint @ ErrorCode::InvalidMint
    )]
    pub buyer_token: Account<'info, TokenAccount>,

    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(seeds = [b"escrow", offer.key().as_ref()], bump)]
    pub escrow_vault_authority: SystemAccount<'info>,

    #[account(mut, seeds = [b"buyer_index", buyer.key().as_ref()], bump)]
    pub buyer_index: Account<'info, BuyerIndex>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConfirmCompletion<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub offer: Account<'info, Offer>,

    #[account(
        mut,
        constraint = buyer_token.owner == offer.buyer @ ErrorCode::Unauthorized,
        constraint = buyer_token.mint == escrow_vault.mint @ ErrorCode::InvalidMint
    )]
    pub buyer_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = seller_token.owner == offer.seller @ ErrorCode::Unauthorized,
        constraint = seller_token.mint == escrow_vault.mint @ ErrorCode::InvalidMint
    )]
    pub seller_token: Account<'info, TokenAccount>,

    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(seeds = [b"escrow", offer.key().as_ref()], bump)]
    pub escrow_vault_authority: SystemAccount<'info>,

    #[account(mut, seeds = [b"buyer_index", offer.buyer.as_ref()], bump)]
    pub buyer_index: Account<'info, BuyerIndex>,

    #[account(mut, seeds = [b"seller_index", offer.seller.as_ref()], bump)]
    pub seller_index: Account<'info, SellerIndex>,

    /// CHECK: Only receives lamports from closed vault
    #[account(mut, constraint = buyer.key() == offer.buyer @ ErrorCode::Unauthorized)]
    pub buyer: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnDeposits<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut)]
    pub offer: Account<'info, Offer>,

    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(seeds = [b"escrow", offer.key().as_ref()], bump)]
    pub escrow_vault_authority: SystemAccount<'info>,

    #[account(mut, seeds = [b"buyer_index", offer.buyer.as_ref()], bump)]
    pub buyer_index: Account<'info, BuyerIndex>,

    #[account(mut, seeds = [b"seller_index", offer.seller.as_ref()], bump)]
    pub seller_index: Account<'info, SellerIndex>,

    /// CHECK: Only receives lamports from closed vault
    #[account(mut, constraint = buyer.key() == offer.buyer @ ErrorCode::Unauthorized)]
    pub buyer: UncheckedAccount<'info>,

    #[account(mut, constraint = mint.key() == TOKEN_MINT @ ErrorCode::InvalidMint)]
    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReadOffer<'info> {
    pub user: Signer<'info>,

    #[account()]
    pub offer: Account<'info, Offer>,
}

// === State / Events / Errors ===
#[account]
pub struct Offer {
    pub buyer: Pubkey,
    pub buyer_vault: Pubkey,
    pub seller: Pubkey,
    pub seller_vault: Pubkey,
    pub amount: u64,
    pub buyer_deposit: u64,
    pub seller_deposit: u64,
    pub code_hash: [u8; 32],
    pub status: OfferStatus,
    pub nonce: u64,
    pub buyer_confirmed: bool,
    pub seller_confirmed: bool,
    pub is_closed: bool,
}

#[account]
pub struct BuyerIndex {
    pub active_offers: Vec<Pubkey>,
    pub next_nonce: u64,
}

#[account]
pub struct SellerIndex {
    pub active_offers: Vec<Pubkey>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum OfferStatus {
    PendingSeller,
    Locked,
    BuyerConfirmed,
    SellerConfirmed,
    Completed,
    Burned,
    Cancelled,
}

#[event] 
pub struct OfferCreated { 
    pub offer: Pubkey, 
    pub buyer: Pubkey, 
    pub amount: u64, 
    pub code_hash: [u8; 32] 
}

#[event] 
pub struct OfferLocked { 
    pub offer: Pubkey, 
    pub seller: Pubkey 
}

#[event] 
pub struct OfferCancelled { 
    pub offer: Pubkey,
    pub buyer: Pubkey,
}

#[event] 
pub struct BuyerConfirmed { 
    pub offer: Pubkey 
}

#[event] 
pub struct SellerConfirmed { 
    pub offer: Pubkey 
}

#[event] 
pub struct OfferCompleted { 
    pub offer: Pubkey 
}

#[event] 
pub struct DepositsBurned { 
    pub offer: Pubkey,
    pub buyer_amount: u64,
    pub seller_amount: u64,
}

#[event]
pub struct OfferRead {
    pub offer: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub buyer_deposit: u64,
    pub seller_deposit: u64,
    pub status: OfferStatus,
    pub buyer_confirmed: bool,
    pub seller_confirmed: bool,
    pub is_closed: bool,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Amount must be greater than zero")] 
    ZeroAmount,
    #[msg("Invalid offer state")] 
    InvalidState,
    #[msg("Wrong code")] 
    InvalidCode,
    #[msg("Code longer than 64 characters")] 
    CodeTooLong,
    #[msg("Code cannot be empty")] 
    EmptyCode,
    #[msg("Insufficient token balance")] 
    InsufficientDeposit,
    #[msg("Invalid mint - token mismatch")] 
    InvalidMint,
    #[msg("Unauthorized")] 
    Unauthorized,
    #[msg("Arithmetic overflow")] 
    Overflow,
    #[msg("Already confirmed")] 
    AlreadyConfirmed,
    #[msg("Offer already accepted")] 
    AlreadyAccepted,
    #[msg("Maximum active offers reached")] 
    MaxOffersReached,
    #[msg("Nonce overflow")] 
    NonceOverflow,
    #[msg("Insufficient vault balance")] 
    InsufficientVaultBalance,
    #[msg("Vault must be empty")] 
    VaultNotEmpty,
    #[msg("Invalid retain operation")] 
    InvalidRetain,
    #[msg("Invalid vault owner")]
    InvalidVaultOwner,
    #[msg("Invalid vault authority")]
    InvalidVaultAuthority,
}