"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface VoucherInfo {
  code: string;
  cantina_name: string;
  experience_name: string;
  url_experience: string;
  status: string;
  expires_at: string;
}

function VoucherLookup() {
  const searchParams = useSearchParams();
  const [code, setCode] = useState(searchParams.get("code") ?? "");
  const [result, setResult] = useState<VoucherInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const initialCode = searchParams.get("code");
    if (initialCode) {
      setCode(initialCode);
      lookup(initialCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function lookup(codeToLookup: string) {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(
        `/api/voucher?code=${encodeURIComponent(codeToLookup.trim())}`
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Errore sconosciuto");
      } else {
        setResult(data as VoucherInfo);
      }
    } catch {
      setError("Errore di rete. Riprova.");
    } finally {
      setLoading(false);
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim()) lookup(code.trim());
  };

  const expiresLabel = result
    ? new Date(result.expires_at).toLocaleDateString("it-IT", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  const statusLabel: Record<string, string> = {
    generated: "✅ Attivo",
    used: "✔️ Già utilizzato",
    expired: "⏰ Scaduto",
    refunded: "↩️ Rimborsato",
  };

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }}>
      <h1 style={{ color: "#7c3626", marginBottom: "0.25rem" }}>
        XtraWine Experience
      </h1>
      <p style={{ color: "#666", marginBottom: "2rem" }}>
        Inserisci il codice voucher ricevuto via email per verificarne la validità.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: "0.5rem" }}>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="XW-XXXX-XXXX"
          style={{
            flex: 1,
            padding: "0.75rem 1rem",
            fontSize: "1.1rem",
            border: "1.5px solid #ccc",
            borderRadius: 6,
            letterSpacing: "0.05em",
            fontFamily: "monospace",
          }}
          maxLength={12}
        />
        <button
          type="submit"
          disabled={loading || !code.trim()}
          style={{
            padding: "0.75rem 1.25rem",
            background: "#7c3626",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          {loading ? "..." : "Verifica"}
        </button>
      </form>

      {error && (
        <div
          style={{
            marginTop: "1.5rem",
            padding: "1rem",
            background: "#fff0f0",
            border: "1px solid #f5c2c2",
            borderRadius: 6,
            color: "#c0392b",
          }}
        >
          {error}
        </div>
      )}

      {result && (
        <div
          style={{
            marginTop: "1.5rem",
            padding: "1.25rem",
            background: "#fff",
            border: "1.5px solid #e0d5c8",
            borderRadius: 8,
          }}
        >
          <p style={{ margin: "0 0 0.5rem", fontWeight: 700, fontSize: "1.1rem" }}>
            {result.experience_name}
          </p>
          <p style={{ margin: "0 0 0.25rem", color: "#555" }}>
            🏰 {result.cantina_name}
          </p>
          <p style={{ margin: "0 0 0.25rem", color: "#555" }}>
            📅 Valido fino al {expiresLabel}
          </p>
          <p style={{ margin: "0 0 1rem" }}>
            <strong>{statusLabel[result.status] ?? result.status}</strong>
          </p>
          {result.url_experience && (
            <a
              href={result.url_experience}
              style={{
                display: "inline-block",
                padding: "0.6rem 1.2rem",
                background: "#7c3626",
                color: "#fff",
                borderRadius: 6,
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Vai alla pagina della cantina →
            </a>
          )}
        </div>
      )}
    </main>
  );
}

export default function VoucherPage() {
  return (
    <Suspense>
      <VoucherLookup />
    </Suspense>
  );
}
