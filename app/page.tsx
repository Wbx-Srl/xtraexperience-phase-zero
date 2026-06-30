import { redirect } from "next/navigation";

interface Props {
  searchParams: Promise<{ shop?: string }>;
}

export default async function HomePage({ searchParams }: Props) {
  const params = await searchParams;

  // Shopify invia shop+hmac all'App URL durante installazione/apertura app
  if (params.shop) {
    redirect(`/api/auth?shop=${params.shop}`);
  }

  return (
    <main style={{ padding: "2rem", textAlign: "center" }}>
      <h1>XtraWine Experience</h1>
      <p>
        Hai acquistato un&apos;experience?{" "}
        <a href="/voucher">Verifica il tuo voucher</a>
      </p>
    </main>
  );
}
