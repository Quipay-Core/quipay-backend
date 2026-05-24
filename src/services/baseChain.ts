/**
 * Base chain integration (Base Sepolia testnet)
 * Reads PayrollVault + PayrollStream contracts via viem.
 * USDC uses 6 decimal places — all returned amounts are human-readable (e.g. 1.50 = $1.50).
 */
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

const IS_MAINNET = process.env.NODE_ENV === "production";

export const baseClient = createPublicClient({
  chain:     IS_MAINNET ? base : baseSepolia,
  transport: http(
    process.env.BASE_RPC_URL ??
      (IS_MAINNET ? "https://mainnet.base.org" : "https://sepolia.base.org")
  ),
});

// ── USDC addresses ────────────────────────────────────────────────────────────
// Mainnet:  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (Circle official)
// Testnet:  0x036CbD53842c5426634e7929541eC2318f3dCF7e (Base Sepolia Circle)
export const USDC_ADDRESS: Address = IS_MAINNET
  ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// ── Contract ABI ──────────────────────────────────────────────────────────────
// Matches the Solidity PayrollVault contract (to be deployed on Base Sepolia)
export const PAYROLL_VAULT_ABI = parseAbi([
  // Write
  "function deposit(address token, uint256 amount) external",
  "function createStream(address worker, address token, uint256 ratePerSecond, uint64 startTs, uint64 endTs) external returns (bytes32 streamId)",
  "function cancelStream(bytes32 streamId) external",
  "function withdraw(bytes32 streamId) external returns (uint256 amount)",
  // Read
  "function getBalance(address employer, address token) external view returns (uint256)",
  "function getStream(bytes32 streamId) external view returns (address employer, address worker, address token, uint256 ratePerSecond, uint64 startTs, uint64 endTs, uint256 withdrawn, bool cancelled)",
  "function getStreamsByWorker(address worker) external view returns (bytes32[])",
  "function getStreamsByEmployer(address employer) external view returns (bytes32[])",
  // Events
  "event StreamCreated(bytes32 indexed streamId, address indexed employer, address indexed worker, address token, uint256 ratePerSecond, uint64 startTs, uint64 endTs)",
  "event Withdrawn(bytes32 indexed streamId, address indexed worker, uint256 amount)",
  "event StreamCancelled(bytes32 indexed streamId)",
  "event Deposited(address indexed employer, address indexed token, uint256 amount)",
]);

// Lazy — address may not be set during tests
function getVaultAddress(): Address | null {
  const addr = process.env.BASE_VAULT_CONTRACT;
  if (!addr || addr === "") return null;
  return addr as Address;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const USDC_DECIMALS = 1_000_000; // 10^6

function toHumanUSDC(raw: bigint): number {
  return Number(raw) / USDC_DECIMALS;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** All stream IDs (bytes32) for a worker on Base */
export async function getWorkerStreamsBase(workerAddress: Address): Promise<Hex[]> {
  const vault = getVaultAddress();
  if (!vault) return [];
  try {
    const ids = await baseClient.readContract({
      address:      vault,
      abi:          PAYROLL_VAULT_ABI,
      functionName: "getStreamsByWorker",
      args:         [workerAddress],
    }) as Hex[];
    return ids;
  } catch {
    return [];
  }
}

/** Full stream details for a given stream ID */
export async function getStreamBase(streamId: Hex) {
  const vault = getVaultAddress();
  if (!vault) return null;
  try {
    const raw = await baseClient.readContract({
      address:      vault,
      abi:          PAYROLL_VAULT_ABI,
      functionName: "getStream",
      args:         [streamId],
    }) as [Address, Address, Address, bigint, bigint, bigint, bigint, boolean];

    const [employer, worker, token, rate, startTs, endTs, withdrawn, cancelled] = raw;
    const now     = BigInt(Math.floor(Date.now() / 1000));
    const elapsed = now > startTs ? now - startTs : 0n;
    const vested  = elapsed * rate;
    const available = vested > withdrawn ? vested - withdrawn : 0n;

    return {
      streamId,
      chain:         "base" as const,
      employer,
      worker,
      token,
      ratePerSecond: toHumanUSDC(rate),
      startTs:       Number(startTs),
      endTs:         Number(endTs),
      withdrawn:     toHumanUSDC(withdrawn),
      available:     toHumanUSDC(available),
      cancelled,
    };
  } catch {
    return null;
  }
}

/** Employer USDC vault balance on Base */
export async function getEmployerBalanceBase(employerAddress: Address): Promise<number> {
  const vault = getVaultAddress();
  if (!vault) return 0;
  try {
    const raw = await baseClient.readContract({
      address:      vault,
      abi:          PAYROLL_VAULT_ABI,
      functionName: "getBalance",
      args:         [employerAddress, USDC_ADDRESS],
    }) as bigint;
    return toHumanUSDC(raw);
  } catch {
    return 0;
  }
}
