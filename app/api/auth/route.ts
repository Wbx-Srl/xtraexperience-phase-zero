import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/auth?shop=xtrawine.myshopify.com
 * Entry point OAuth — redirige il merchant a Shopify per l'approvazione degli scope.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const shop = req.nextUrl.searchParams.get("shop");
  if (!shop || !shop.endsWith(".myshopify.com")) {
    return NextResponse.json({ error: "Parametro shop mancante o non valido" }, { status: 400 });
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID!;
  const redirectUri = `${process.env.APP_BASE_URL}/api/auth/callback`;
  const scopes = [
    "read_orders",
    "write_orders",
    "read_products",
    "write_discounts",
  ].join(",");

  // Nonce semplice basato su timestamp — sufficiente per una Custom App mono-merchant
  const state = Buffer.from(`${Date.now()}`).toString("hex");

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${clientId}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  return NextResponse.redirect(authUrl);
}
