import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { registerWebhook } from "@/lib/shopify";

/**
 * GET /api/auth/callback?code=...&shop=...&state=...
 * Completa il flusso OAuth: scambia il code con l'access token,
 * lo salva su Vercel KV e registra i webhook necessari.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const shop = searchParams.get("shop");
  const code = searchParams.get("code");

  if (!shop || !code) {
    return NextResponse.json({ error: "Parametri OAuth mancanti" }, { status: 400 });
  }

  // Scambio code → access token
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      code,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error("OAuth token exchange failed:", body);
    return NextResponse.json({ error: "Token exchange fallito" }, { status: 502 });
  }

  const { access_token, scope } = await tokenRes.json();

  // Salva token su Vercel KV
  await kv.set(`shop:${shop}`, {
    shop,
    access_token,
    scope,
    installed_at: new Date().toISOString(),
  });

  // Registra webhook (idempotente: Shopify ignora duplicati con stesso topic+address)
  const baseUrl = process.env.APP_BASE_URL!;
  const webhooks = [
    { topic: "orders/paid", address: `${baseUrl}/api/order-paid` },
    { topic: "orders/refunded", address: `${baseUrl}/api/webhooks/orders-refunded` },
    { topic: "orders/cancelled", address: `${baseUrl}/api/webhooks/orders-cancelled` },
    { topic: "customers/data_request", address: `${baseUrl}/api/gdpr/customers-data-request` },
    { topic: "customers/redact", address: `${baseUrl}/api/gdpr/customers-redact` },
    { topic: "shop/redact", address: `${baseUrl}/api/gdpr/shop-redact` },
  ];

  await Promise.allSettled(
    webhooks.map((wh) => registerWebhook(shop, access_token, wh.topic, wh.address))
  );

  console.log(`App installata su ${shop}, scope: ${scope}`);
  return NextResponse.redirect(`https://${shop}/admin`);
}
