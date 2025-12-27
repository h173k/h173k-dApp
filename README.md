# h173k Escrow dApp

A decentralized escrow application for the h173k token on Solana blockchain.

## Features

- 🔗 **Wallet Connection**: Support for Phantom, Solflare, and Torus wallets
- 📝 **Create Contracts**: Create new escrow contracts with automatic code generation
- ✅ **Accept Contracts**: Accept existing contracts as a seller
- 💰 **Release Funds**: Confirm completion to release funds
- 🔥 **Burn Option**: Burn all deposits in case of dispute
- 📱 **Mobile-First Design**: Optimized for vertical mobile use

## Tech Stack

- **Frontend**: React 19 + Vite
- **Blockchain**: Solana (Devnet for testing)
- **Smart Contract**: Anchor Framework
- **Wallet Integration**: Solana Wallet Adapter
- **Styling**: Custom CSS with animations

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- A Solana wallet (Phantom recommended)

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd h173k-escrow-dapp

# Install dependencies
npm install

# Start development server
npm run dev
```

### Building for Production

```bash
npm run build
```

The build output will be in the `dist` directory.

## Deployment to Cloudflare Pages

1. Push your code to a Git repository (GitHub, GitLab, etc.)
2. Connect your repository to Cloudflare Pages
3. Configure build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Deploy!

## Configuration

### Network Settings

The app is currently configured for **Devnet**. To switch to mainnet:

1. Edit `src/constants.js`
2. Change `NETWORK` to `'mainnet-beta'`
3. Update `TOKEN_MINT` to the mainnet token address

### Token Configuration

- **Devnet Token**: `DcAwQFCWCLjbaFa2j67pXx4S9Caeo6YkdZURmAsLkZTT`
- **Mainnet Token**: `173AvoJNQoWsaR1wdYTMNLUqZc1b7d4SzB2ZZRZVyz3`

## Smart Contract

Program ID: `pLEzeCQ8t7oz2YGzZmqz4a1mXNhhE3mJC89GSveijrG`

### Contract Flow

1. **Buyer creates offer**: Deposits 2x the contract amount
2. **Seller accepts**: Deposits 1x the contract amount with the secret code
3. **Both confirm**: Both parties confirm completion
4. **Funds released**: Seller gets the amount, both get deposits back

### Burn Option

If there's a dispute, either party can burn all deposits. This destroys all tokens in the escrow.

## Project Structure

```
src/
├── App.jsx          # Main application component
├── App.css          # Styles
├── main.jsx         # Entry point
├── constants.js     # Configuration constants
├── idl.js           # Anchor IDL for the smart contract
├── useEscrow.js     # Hook for escrow operations
├── usePrice.js      # Hook for CoinGecko price fetching
└── utils.js         # Utility functions
```

## License

MIT
