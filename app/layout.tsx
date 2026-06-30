import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "XtraWine Experience",
  description: "Verifica il tuo voucher experience",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body style={{ margin: 0, fontFamily: "sans-serif", background: "#fafaf8" }}>
        {children}
      </body>
    </html>
  );
}
