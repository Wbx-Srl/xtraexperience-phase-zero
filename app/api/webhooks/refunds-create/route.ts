import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { verifyShopifyHmac } from "@/lib/hmac";
import { refundOrderVouchers } from "@/lib/refund";

interface ShopifyRefund {
  order_id: string | number;
  refund_line_items?: { line_item_id: string | number; quantity: number }[];
}

/**
 * POST /api/webhooks/refunds-create
 * Riceve webhook refunds/create da Shopify (anche rimborsi parziali): annulla
 * solo i voucher delle righe/quantita' rimborsate e i relativi codici sconto.
 * Un rimborso solo di importo (senza refund_line_items) non annulla nulla.
 * Risponde 200 SUBITO, poi processa in background.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256") ?? "";
  const shop = req.headers.get("x-shopify-shop-domain") ?? "";

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET!;
  if (!verifyShopifyHmac(rawBody, hmacHeader, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const refund = JSON.parse(rawBody.toString("utf-8")) as ShopifyRefund;
  const items = (refund.refund_line_items ?? []).map((rli) => ({
    line_item_id: String(rli.line_item_id),
    quantity: rli.quantity,
  }));

  if (items.length > 0) {
    waitUntil(
      refundOrderVouchers(
        shop,
        String(refund.order_id),
        { type: "line_items", items },
        "refunds-create"
      ).catch((err) => console.error("refunds-create processing error:", err))
    );
  }

  return NextResponse.json({ ok: true });
}
