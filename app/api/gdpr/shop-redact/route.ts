import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { verifyShopifyHmac } from "@/lib/hmac";

/** POST /api/gdpr/shop-redact */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const hmac = req.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!verifyShopifyHmac(rawBody, hmac, process.env.SHOPIFY_WEBHOOK_SECRET!)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody.toString());
  // Rimozione token shop da KV
  const shop = payload.shop_domain as string;
  if (shop) await kv.del(`shop:${shop}`);

  console.log("GDPR shop/redact completato per:", shop);
  return NextResponse.json({ ok: true });
}
