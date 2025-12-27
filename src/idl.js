// IDL for Anchor 0.29 - v7 with SellerIndex (FIXED to match deployed contract)
// WAŻNE: Ten IDL musi dokładnie odpowiadać kolejności kont w smart contract!

export const IDL = {
  version: '0.1.0',
  name: 'h173k_escrow_v7',
  instructions: [
    {
      name: 'initializeBuyerIndex',
      accounts: [
        { name: 'buyer', isMut: true, isSigner: true },
        { name: 'buyerIndex', isMut: true, isSigner: false },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: 'initializeSellerIndex',
      accounts: [
        { name: 'seller', isMut: true, isSigner: true },
        { name: 'sellerIndex', isMut: true, isSigner: false },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: 'createOffer',
      accounts: [
        { name: 'buyer', isMut: true, isSigner: true },
        { name: 'buyerIndex', isMut: true, isSigner: false },
        { name: 'offer', isMut: true, isSigner: false },
        { name: 'escrowVault', isMut: true, isSigner: false },
        { name: 'escrowVaultAuthority', isMut: false, isSigner: false },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'buyerToken', isMut: true, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'associatedTokenProgram', isMut: false, isSigner: false },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'amount', type: 'u64' },
        { name: 'codeHash', type: { array: ['u8', 32] } },
      ],
    },
    {
      // FIXED: Dodano sellerIndex zgodnie ze smart contractem
      // Kolejność kont MUSI odpowiadać strukturze AcceptOffer w Rust
      name: 'acceptOffer',
      accounts: [
        { name: 'seller', isMut: true, isSigner: true },
        { name: 'offer', isMut: true, isSigner: false },
        { name: 'sellerIndex', isMut: true, isSigner: false },  // <-- DODANE!
        { name: 'sellerToken', isMut: true, isSigner: false },
        { name: 'escrowVault', isMut: true, isSigner: false },
        { name: 'escrowVaultAuthority', isMut: false, isSigner: false },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
      ],
      args: [{ name: 'code', type: 'string' }],
    },
    {
      name: 'cancelOffer',
      accounts: [
        { name: 'buyer', isMut: true, isSigner: true },
        { name: 'offer', isMut: true, isSigner: false },
        { name: 'buyerToken', isMut: true, isSigner: false },
        { name: 'escrowVault', isMut: true, isSigner: false },
        { name: 'escrowVaultAuthority', isMut: false, isSigner: false },
        { name: 'buyerIndex', isMut: true, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      // FIXED: Dodano sellerIndex zgodnie ze smart contractem
      name: 'confirmCompletion',
      accounts: [
        { name: 'user', isMut: true, isSigner: true },
        { name: 'offer', isMut: true, isSigner: false },
        { name: 'buyerToken', isMut: true, isSigner: false },
        { name: 'sellerToken', isMut: true, isSigner: false },
        { name: 'escrowVault', isMut: true, isSigner: false },
        { name: 'escrowVaultAuthority', isMut: false, isSigner: false },
        { name: 'buyerIndex', isMut: true, isSigner: false },
        { name: 'sellerIndex', isMut: true, isSigner: false },  // <-- DODANE!
        { name: 'buyer', isMut: true, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      // FIXED: Dodano sellerIndex zgodnie ze smart contractem
      name: 'burnDeposits',
      accounts: [
        { name: 'signer', isMut: true, isSigner: true },
        { name: 'offer', isMut: true, isSigner: false },
        { name: 'escrowVault', isMut: true, isSigner: false },
        { name: 'escrowVaultAuthority', isMut: false, isSigner: false },
        { name: 'buyerIndex', isMut: true, isSigner: false },
        { name: 'sellerIndex', isMut: true, isSigner: false },  // <-- DODANE!
        { name: 'buyer', isMut: true, isSigner: false },
        { name: 'mint', isMut: true, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: 'readOffer',
      accounts: [
        { name: 'user', isMut: false, isSigner: true },
        { name: 'offer', isMut: false, isSigner: false },
      ],
      args: [{ name: 'code', type: 'string' }],
    },
  ],
  accounts: [
    {
      name: 'offer',
      type: {
        kind: 'struct',
        fields: [
          { name: 'buyer', type: 'publicKey' },
          { name: 'buyerVault', type: 'publicKey' },
          { name: 'seller', type: 'publicKey' },
          { name: 'sellerVault', type: 'publicKey' },
          { name: 'amount', type: 'u64' },
          { name: 'buyerDeposit', type: 'u64' },
          { name: 'sellerDeposit', type: 'u64' },
          { name: 'codeHash', type: { array: ['u8', 32] } },
          { name: 'status', type: { defined: 'OfferStatus' } },
          { name: 'nonce', type: 'u64' },
          { name: 'buyerConfirmed', type: 'bool' },
          { name: 'sellerConfirmed', type: 'bool' },
          { name: 'isClosed', type: 'bool' },
        ],
      },
    },
    {
      name: 'buyerIndex',
      type: {
        kind: 'struct',
        fields: [
          { name: 'activeOffers', type: { vec: 'publicKey' } },
          { name: 'nextNonce', type: 'u64' },
        ],
      },
    },
    {
      name: 'sellerIndex',
      type: {
        kind: 'struct',
        fields: [
          { name: 'activeOffers', type: { vec: 'publicKey' } },
        ],
      },
    },
  ],
  types: [
    {
      name: 'OfferStatus',
      type: {
        kind: 'enum',
        variants: [
          { name: 'PendingSeller' },
          { name: 'Locked' },
          { name: 'BuyerConfirmed' },
          { name: 'SellerConfirmed' },
          { name: 'Completed' },
          { name: 'Burned' },
          { name: 'Cancelled' },
        ],
      },
    },
  ],
  errors: [
    { code: 6000, name: 'ZeroAmount', msg: 'Amount must be greater than zero' },
    { code: 6001, name: 'InvalidState', msg: 'Invalid offer state' },
    { code: 6002, name: 'InvalidCode', msg: 'Wrong code' },
    { code: 6003, name: 'CodeTooLong', msg: 'Code longer than 64 characters' },
    { code: 6004, name: 'EmptyCode', msg: 'Code cannot be empty' },
    { code: 6005, name: 'InsufficientDeposit', msg: 'Insufficient token balance' },
    { code: 6006, name: 'InvalidMint', msg: 'Invalid mint - token mismatch' },
    { code: 6007, name: 'Unauthorized', msg: 'Unauthorized' },
    { code: 6008, name: 'Overflow', msg: 'Arithmetic overflow' },
    { code: 6009, name: 'AlreadyConfirmed', msg: 'Already confirmed' },
    { code: 6010, name: 'AlreadyAccepted', msg: 'Offer already accepted' },
    { code: 6011, name: 'MaxOffersReached', msg: 'Maximum active offers reached' },
    { code: 6012, name: 'NonceOverflow', msg: 'Nonce overflow' },
    { code: 6013, name: 'InsufficientVaultBalance', msg: 'Insufficient vault balance' },
    { code: 6014, name: 'VaultNotEmpty', msg: 'Vault must be empty' },
    { code: 6015, name: 'InvalidRetain', msg: 'Invalid retain operation' },
    { code: 6016, name: 'InvalidVaultOwner', msg: 'Invalid vault owner' },
    { code: 6017, name: 'InvalidVaultAuthority', msg: 'Invalid vault authority' },
  ],
}