import { kv } from "@/lib/kv";
import {
  deleteCrossSellingDiscount,
  markOrderMetafieldVouchersRefunded,
} from "@/lib/shopify";
import type { VoucherRecord, OrderVoucherSummary } from "@/lib/voucher";

/**
 * Quali voucher annullare:
 * - "all": ordine annullato (orders/cancelled), tutti i voucher dell'ordine
 * - "line_items": rimborso (refunds/create), solo le righe/quantita' rimborsate
 */
export type RefundScope =
  | { type: "all" }
  | { type: "line_items"; items: { line_item_id: string; quantity: number }[] };

// Annullamento con rimborso in Admin manda orders/cancelled e refunds/create
// quasi insieme: entrambi fanno read-modify-write su order:${orderId}, quindi
// si serializzano con un lock per ordine per non perdere aggiornamenti.
const LOCK_TTL_S = 120;
const LOCK_RETRY_MS = 1000;
const LOCK_MAX_ATTEMPTS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(key: string): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    const res = await kv.set(key, "1", { nx: true, ex: LOCK_TTL_S });
    if (res === "OK") return true;
    await sleep(LOCK_RETRY_MS);
  }
  return false;
}

/**
 * Sceglie i codici voucher da annullare. Con quantity > 1 sulla stessa riga
 * i voucher condividono line_item_id (normalizzato, vedi order-paid) e sono
 * in ordine di generazione: si annullano gli ULTIMI generati tra quelli non
 * ancora annullati (decisione 9666a4bc).
 */
function selectCodesToRefund(
  summaries: OrderVoucherSummary[],
  scope: RefundScope
): string[] {
  const active = summaries.filter((s) => s.status !== "refunded");
  if (scope.type === "all") return active.map((s) => s.code);

  const selected: string[] = [];
  for (const item of scope.items) {
    if (item.quantity <= 0) continue;
    const candidates = active.filter(
      (s) => s.line_item_id === item.line_item_id && !selected.includes(s.code)
    );
    selected.push(...candidates.slice(-item.quantity).map((s) => s.code));
  }
  return selected;
}

/**
 * Marca come "refunded" i voucher di un ordine (record voucher:${code} letto
 * dal popup pubblico, array order:${orderId} letto dall'ERP, metafield
 * ordine) ed elimina i relativi codici sconto cross-selling.
 * Idempotente: voucher gia' annullati vengono saltati.
 */
export async function refundOrderVouchers(
  shop: string,
  orderId: string,
  scope: RefundScope,
  source: string
): Promise<void> {
  const shopData = await kv.get<{ access_token: string }>(`shop:${shop}`);
  if (!shopData?.access_token) {
    console.error(`[${source}] Access token non trovato per shop: ${shop}`);
    return;
  }
  const accessToken = shopData.access_token;

  const lockKey = `lock:refund:${orderId}`;
  const locked = await acquireLock(lockKey);
  if (!locked) {
    console.error(`[${source}] Lock ordine ${orderId} non ottenuto, procedo comunque.`);
  }

  try {
    const summaries = await kv.get<OrderVoucherSummary[]>(`order:${orderId}`);
    if (!summaries || summaries.length === 0) {
      console.log(`[${source}] Ordine ${orderId}: nessun voucher su KV, skip.`);
      return;
    }

    const codes = selectCodesToRefund(summaries, scope);
    if (codes.length === 0) {
      console.log(`[${source}] Ordine ${orderId}: nessun voucher da annullare.`);
      return;
    }

    const refundedAt = new Date().toISOString();
    const discountCodes: string[] = [];

    for (const code of codes) {
      const voucher = await kv.get<VoucherRecord>(`voucher:${code}`);
      if (!voucher) {
        console.error(`[${source}] Record voucher:${code} mancante su KV.`);
        continue;
      }
      if (voucher.discount_code) discountCodes.push(voucher.discount_code);
      if (voucher.status === "refunded") continue;
      await kv.set(`voucher:${code}`, {
        ...voucher,
        status: "refunded",
        refunded_at: refundedAt,
      });
    }

    const updatedSummaries = summaries.map((s) =>
      codes.includes(s.code) ? { ...s, status: "refunded", refunded_at: refundedAt } : s
    );
    // keepTtl: conserva la scadenza di 2 anni impostata da order-paid
    await kv.set(`order:${orderId}`, updatedSummaries, { keepTtl: true });

    console.log(`[${source}] Ordine ${orderId}: voucher annullati ${codes.join(", ")}`);

    for (const discountCode of discountCodes) {
      try {
        await deleteCrossSellingDiscount(shop, accessToken, discountCode);
      } catch (e) {
        console.error(`[${source}] Eliminazione codice sconto ${discountCode} fallita:`, e);
      }
    }

    try {
      await markOrderMetafieldVouchersRefunded(shop, accessToken, orderId, codes, refundedAt);
    } catch (e) {
      // Non blocca il flusso — il KV è la source of truth
      console.error(`[${source}] Metafield ordine ${orderId} update failed:`, e);
    }
  } finally {
    if (locked) await kv.del(lockKey);
  }
}
