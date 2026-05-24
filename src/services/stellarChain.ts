import {
  Account,
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  Address,
} from "@stellar/stellar-sdk";

const STROOPS = 1e7;

// Neutral public key for simulations that don't require a real on-chain account.
const NEUTRAL_PK = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

// Read lazily so dotenv.config() in index.ts has time to populate process.env before first call.
function getRpcUrl()          { return process.env.PUBLIC_STELLAR_RPC_URL ?? process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org"; }
function getNetworkPassphrase() { return process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015"; }
function getContractId()      { return process.env.PAYROLL_STREAM_CONTRACT_ID ?? ""; }

function getServer(): SorobanRpc.Server {
  return new SorobanRpc.Server(getRpcUrl(), { allowHttp: true });
}

async function simulateRead<T>(
  sourceAddress: string,
  operation: ReturnType<Contract["call"]>,
): Promise<T | null> {
  const server = getServer();

  let source: Account;
  try {
    source = await server.getAccount(sourceAddress);
  } catch (e) {
    console.warn(`[stellarChain] getAccount(${sourceAddress}) failed, using neutral key:`, (e as Error).message);
    source = new Account(NEUTRAL_PK, "0");
  }

  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: getNetworkPassphrase() })
    .addOperation(operation)
    .setTimeout(10)
    .build();

  let res: Awaited<ReturnType<SorobanRpc.Server["simulateTransaction"]>>;
  try {
    res = await server.simulateTransaction(tx);
  } catch (e) {
    console.error("[stellarChain] simulateTransaction threw:", (e as Error).message);
    return null;
  }

  if (SorobanRpc.Api.isSimulationError(res)) {
    console.error("[stellarChain] simulation returned error:", (res as SorobanRpc.Api.SimulateTransactionErrorResponse).error);
    return null;
  }

  // Handle restore response (expired ledger entries)
  if ("restorePreamble" in res && !("result" in res && (res as any).result)) {
    console.warn("[stellarChain] simulation needs state restore — ledger entry may have expired TTL");
    return null;
  }

  const retval = (res as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) {
    console.warn("[stellarChain] simulation succeeded but retval is empty. res keys:", Object.keys(res));
    return null;
  }

  try {
    return (scValToNative(retval) as T) ?? null;
  } catch (e) {
    console.error("[stellarChain] scValToNative failed:", (e as Error).message);
    return null;
  }
}

export interface StellarStream {
  streamId: string;
  employer: string;
  worker: string;
  token: string;
  ratePerSecond: number;
  startTs: number;
  endTs: number;
  cliffTs: number;
  totalAmount: number;
  withdrawnAmount: number;
  status: number;
}

/**
 * Fetches all stream IDs for a worker directly from the PayrollStream contract.
 */
export async function getWorkerStreamIdsStellar(workerAddress: string): Promise<bigint[]> {
  const contractId = getContractId();
  if (!contractId) return [];
  const contract = new Contract(contractId);
  const ids = await simulateRead<bigint[]>(
    workerAddress,
    contract.call(
      "get_streams_by_worker",
      new Address(workerAddress).toScVal(),
      nativeToScVal(null),
      nativeToScVal(null),
    ),
  );
  return ids ?? [];
}

/**
 * Fetches a single stream by ID from the PayrollStream contract.
 */
export async function getStellarStreamById(
  workerAddress: string,
  streamId: bigint,
): Promise<StellarStream | null> {
  const contractId = getContractId();
  if (!contractId) return null;
  const contract = new Contract(contractId);

  const raw = await simulateRead<Record<string, unknown>>(
    workerAddress,
    contract.call(
      "get_stream",
      nativeToScVal(streamId, { type: "u64" }),
    ),
  );

  if (!raw) return null;

  const toBigInt = (v: unknown): bigint =>
    typeof v === "bigint" ? v : BigInt(String(v ?? "0"));
  const toNum = (v: unknown): number => Number(toBigInt(v));
  const toStatus = (v: unknown): number =>
    typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0;

  const rate = toBigInt(raw.rate);

  return {
    streamId:       streamId.toString(),
    employer:       String(raw.employer ?? ""),
    worker:         String(raw.worker ?? ""),
    token:          String(raw.token ?? ""),
    ratePerSecond:  Number(rate) / STROOPS,
    startTs:        toNum(raw.start_ts),
    endTs:          toNum(raw.end_ts),
    cliffTs:        toNum(raw.cliff_ts),
    totalAmount:    toNum(raw.total_amount) / STROOPS,
    withdrawnAmount:toNum(raw.withdrawn_amount) / STROOPS,
    status:         toStatus(raw.status),
  };
}

/**
 * Fetches all streams for a worker with live on-chain data.
 * Returns streams, total available balance, and total streaming rate.
 */
export async function getWorkerStreamsStellar(workerAddress: string): Promise<{
  streams: StellarStream[];
  totalAvailable: number;
  streamingPerSec: number;
  withdrawn: number;
}> {
  const ids = await getWorkerStreamIdsStellar(workerAddress);
  if (ids.length === 0) return { streams: [], totalAvailable: 0, streamingPerSec: 0, withdrawn: 0 };

  const results = await Promise.all(
    ids.map(id => getStellarStreamById(workerAddress, id))
  );

  const streams = results.filter((s): s is StellarStream => s !== null);
  const now = Math.floor(Date.now() / 1000);

  let totalAvailable = 0;
  let streamingPerSec = 0;
  let withdrawn = 0;

  for (const s of streams) {
    if (s.status !== 0) continue; // skip cancelled/completed
    const effectiveCliff = s.cliffTs > 0 ? s.cliffTs : s.startTs;
    const elapsed = Math.max(0, now - s.startTs);
    const vested = Math.min(elapsed * s.ratePerSecond, s.totalAmount);
    const available = now >= effectiveCliff ? Math.max(0, vested - s.withdrawnAmount) : 0;
    totalAvailable += available;
    streamingPerSec += s.ratePerSecond;
    withdrawn += s.withdrawnAmount;
  }

  return { streams, totalAvailable, streamingPerSec, withdrawn };
}
