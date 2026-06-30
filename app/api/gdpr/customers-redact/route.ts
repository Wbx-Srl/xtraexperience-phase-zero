import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { verifyShopifyHmac } from "@/lib/hmac";

interface RedactPayload {
  customer: { id: number; email: string };
  orders_to_redact: Array<{ id: number }>;
}

/** POST /api/gdpr/customers-redact */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const hmac = req.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!verifyShopifyHmac(rawBody, hmac, process.env.SHOPIFY_WEBHOOK_SECRET!)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody.toString()) as RedactPayload;

  // Elimina le chiavi order:{id} per gli ordini del cliente
  for (const order of payload.orders_to_redact ?? []) {
    await kv.del(`order:${order.id}`);
    await kv.del(`processed:${order.id}`);
  }

  console.log("GDPR customers/redact completato per:", payload.customer?.email);
  return NextResponse.json({ ok: true });
}
