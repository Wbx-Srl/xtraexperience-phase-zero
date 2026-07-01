import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { kv } from "@/lib/kv";
import { verifyShopifyHmac } from "@/lib/hmac";
import {
  getProductMetafields,
  getProductType,
  writeOrderMetafield,
  createCrossSellingDiscount,
} from "@/lib/shopify";
import { generateVoucherCode, generateDiscountCode } from "@/lib/voucher";
import type { VoucherRecord, OrderVoucherSummary } from "@/lib/voucher";
import { trackVoucherGenerated, trackVoucherSold } from "@/lib/klaviyo";

const EXPERIENCE_PRODUCT_TYPE = process.env.EXPERIENCE_PRODUCT_TYPE ?? "Experience";
const PAYPAL_DELAY_MS = parseInt(process.env.PAYPAL_DELAY_MINUTES ?? "30") * 60 * 1000;
const DISCOUNT_VALIDITY_DAYS = parseInt(process.env.DISCOUNT_VALIDITY_DAYS ?? "30");
const APP_BASE_URL = process.env.APP_BASE_URL!;

// ── Tipi Shopify ──────────────────────────────────────────────────────────────

interface ShopifyLineItem {
  id: string;
  product_id: string;
  title: string;
  quantity: number;
  product_type: string;
  vendor: string;
}

interface ShopifyOrder {
  id: string;
  order_number: number;
  email: string;
  customer?: { first_name?: string; last_name?: string; email?: string };
  line_items: ShopifyLineItem[];
  payment_gateway: string;
  created_at: string;
}

// ── Route handler ─────────────────────────────────────────────────────────────

/**
 * POST /api/order-paid
 * Riceve webhook orders/paid da Shopify.
 * Risponde 200 SUBITO, poi processa in background.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Leggi il body raw per HMAC
  const rawBody = Buffer.from(await req.arrayBuffer());
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256") ?? "";
  const shop = req.headers.get("x-shopify-shop-domain") ?? "";

  // 2. Verifica HMAC
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET!;
  if (!verifyShopifyHmac(rawBody, hmacHeader, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 3. Risponde 200 SUBITO — waitUntil mantiene la funzione viva fino al completamento
  waitUntil(
    processOrder(shop, JSON.parse(rawBody.toString("utf-8")) as ShopifyOrder).catch(
      (err) => console.error("order-paid processing error:", err)
    )
  );

  return NextResponse.json({ ok: true });
}

// ── Processing ordine ─────────────────────────────────────────────────────────

async function processOrder(shop: string, order: ShopifyOrder): Promise<void> {
  const orderId = String(order.id);

  // Leggi access token da KV
  const shopData = await kv.get<{ access_token: string }>(`shop:${shop}`);
  if (!shopData?.access_token) {
    console.error(`Access token non trovato per shop: ${shop}`);
    return;
  }
  const accessToken = shopData.access_token;

  // 4. Idempotenza ordine
  const orderKey = `processed:${orderId}`;
  const alreadyProcessed = await kv.get(orderKey);
  if (alreadyProcessed) {
    console.log(`Ordine ${orderId} già processato, skip.`);
    return;
  }
  // Imposta flag con TTL 30 giorni
  await kv.set(orderKey, "1", { ex: 30 * 24 * 60 * 60 });

  // 6. Log diagnostico + risoluzione product_type via API se vuoto nel webhook
  console.log(
    `Ordine ${orderId} line_items product_types (raw):`,
    order.line_items.map((i) => `[${i.id}] "${i.product_type}"`).join(", ")
  );

  // Arricchisci product_type dai dati prodotto se il webhook lo manda vuoto/assente
  const enrichedItems = await Promise.all(
    order.line_items.map(async (item) => {
      const pt = item.product_type || "";
      if (pt) return item;
      const fetched = await getProductType(shop, accessToken, item.product_id);
      return { ...item, product_type: fetched };
    })
  );

  console.log(
    `Ordine ${orderId} line_items product_types (enriched):`,
    enrichedItems.map((i) => `[${i.id}] "${i.product_type}"`).join(", ")
  );

  const hasWine = enrichedItems.some(
    (i) => i.product_type !== EXPERIENCE_PRODUCT_TYPE
  );

  const experienceItems = enrichedItems.filter(
    (i) => i.product_type === EXPERIENCE_PRODUCT_TYPE
  );

  if (experienceItems.length === 0) {
    console.log(`Ordine ${orderId}: nessuna experience, skip.`);
    return;
  }

  const orderNumber = `#${order.order_number}`;
  const customerEmail = order.customer?.email ?? order.email;
  const customerName = [order.customer?.first_name, order.customer?.last_name]
    .filter(Boolean)
    .join(" ") || "Cliente";
  const isPaypal = order.payment_gateway === "paypal";

  const orderVoucherSummaries: OrderVoucherSummary[] = [];
  const voucherRecordsForMetafield: object[] = [];

  // 7. Loop line_items experience
  for (const item of experienceItems) {
    // Genera N voucher se quantity > 1
    for (let qty = 0; qty < item.quantity; qty++) {
      const lineItemKey = qty === 0 ? item.id : `${item.id}-${qty}`;

      // a. Idempotenza line_item
      const liKey = `processed:${orderId}:${lineItemKey}`;
      const alreadyDone = await kv.get(liKey);
      if (alreadyDone) continue;

      // b. Genera codice voucher
      const salt = process.env.VOUCHER_SECRET_SALT!;
      const code = generateVoucherCode(orderId, String(lineItemKey), salt);

      // c-f. Leggi metafield prodotto
      const meta = await getProductMetafields(shop, accessToken, item.product_id);

      // g. Genera codice sconto cross-selling (uno per ordine per cantina, non per voucher)
      const discountCode = generateDiscountCode(meta.cantina_name, orderId, salt);
      const discountDescription = `10% sui vini ${meta.cantina_name} — valido ${DISCOUNT_VALIDITY_DAYS} giorni, una sola volta`;

      if (qty === 0) {
        // Crea il discount code una sola volta per cantina per ordine
        await createCrossSellingDiscount(
          shop,
          accessToken,
          discountCode,
          meta.cantina_name,
          DISCOUNT_VALIDITY_DAYS
        );
      }

      const generatedAt = new Date().toISOString();
      const expiresAt = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000
      ).toISOString(); // 1 anno

      const voucher: VoucherRecord = {
        line_item_id: String(lineItemKey),
        order_id: orderId,
        code,
        cantina_name: meta.cantina_name,
        cantina_email: meta.cantina_email,
        experience_name: item.title,
        url_experience: meta.url,
        instructions: meta.instructions,
        discount_code: discountCode,
        discount_description: discountDescription,
        status: "generated",
        generated_at: generatedAt,
        expires_at: expiresAt,
        customer_email: customerEmail,
        customer_name: customerName,
        order_number: orderNumber,
        payment_gateway: order.payment_gateway,
      };

      // 9. Salva voucher su KV
      await kv.set(`voucher:${code}`, voucher);
      await kv.set(liKey, "1", { ex: 30 * 24 * 60 * 60 });

      orderVoucherSummaries.push({
        line_item_id: String(lineItemKey),
        code,
        cantina_name: meta.cantina_name,
        experience_name: item.title,
        expires_at: expiresAt,
        status: "generated",
      });

      voucherRecordsForMetafield.push({
        line_item_id: String(lineItemKey),
        code,
        cantina: meta.cantina_name,
        url_experience: meta.url,
        instructions: meta.instructions,
        discount_code: discountCode,
        status: "generated",
        generated_at: generatedAt,
        expires_at: expiresAt,
      });

      // 11. Invio email Klaviyo — 1 email per voucher
      const sendEmails = async () => {
        const klaviyoKey = process.env.KLAVIYO_API_KEY!;
        const qrUrl = `${APP_BASE_URL}/voucher?code=${code}`;

        await trackVoucherGenerated(klaviyoKey, customerEmail, {
          code,
          cantina_name: meta.cantina_name,
          experience_name: item.title,
          url_experience: meta.url,
          expires_at: expiresAt,
          qr_url: qrUrl,
          order_number: orderNumber,
          instructions: meta.instructions,
          discount_code: discountCode,
          discount_description: discountDescription,
          payment_gateway: order.payment_gateway,
        });
        console.log(`Klaviyo VoucherGenerated inviato per ${code} → ${customerEmail}`);

        if (meta.cantina_email) {
          await trackVoucherSold(klaviyoKey, meta.cantina_email, {
            code,
            customer_name: customerName,
            customer_email: customerEmail,
            experience_name: item.title,
            order_number: orderNumber,
            expires_at: expiresAt,
          });
        }
      };

      if (isPaypal && PAYPAL_DELAY_MS > 0) {
        // Ritardo anti-frode PayPal: non blocca il loop, si esegue in background
        setTimeout(() => {
          sendEmails().catch((e) =>
            console.error(`Klaviyo delayed send failed for ${code}:`, e)
          );
        }, PAYPAL_DELAY_MS);
      } else {
        await sendEmails();
      }
    }
  }

  // 9b. Salva array ordine su KV (per ERP) con TTL 2 anni
  if (orderVoucherSummaries.length > 0) {
    await kv.set(`order:${orderId}`, orderVoucherSummaries, {
      ex: 2 * 365 * 24 * 60 * 60,
    });

    // 10. Scrivi metafield ordine su Shopify
    try {
      await writeOrderMetafield(shop, accessToken, orderId, voucherRecordsForMetafield);
    } catch (e) {
      // Non blocca il flusso — il KV è la source of truth
      console.error("Metafield ordine write failed:", e);
    }
  }

  console.log(
    `Ordine ${orderId} processato: ${orderVoucherSummaries.length} voucher, hasWine=${hasWine}`
  );
}
