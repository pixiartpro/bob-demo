// Webhook HelloAsso : appele quand un paiement change d'etat. Gate par ?token= (Vault).
// Re-verifie TOUJOURS le checkout directement chez HelloAsso (jamais confiance au corps brut).
// v3 (30/06/2026) : compare le montant REELLEMENT encaisse au montant DU (#6 de l'audit).
//   -> si egal : "paye" ; si different : "a_verifier" (jamais "paye" sur un montant qui ne colle pas).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HA_API = "https://api.helloasso.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function haToken(cfg: any): Promise<string> {
  const r = await fetch(`${HA_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.client_id, client_secret: cfg.client_secret }),
  });
  if (!r.ok) throw new Error(`oauth ${r.status}`);
  return (await r.json()).access_token;
}

Deno.serve(async (req) => {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  let cfg: any = null;
  try { cfg = (await admin.rpc("helloasso_config")).data; } catch (_) { cfg = null; }

  const url = new URL(req.url);
  if (!cfg?.webhook_token || url.searchParams.get("token") !== cfg.webhook_token)
    return new Response("forbidden", { status: 403 });

  let body: any = {};
  try { body = await req.json(); } catch (_) { /* ignore */ }

  const meta = body?.metadata ?? body?.data?.metadata ?? {};
  const paiement_id = meta?.paiement_id;
  if (!paiement_id) return new Response("no-metadata", { status: 200 });

  const { data: pay } = await admin.from("paiements").select("*").eq("id", paiement_id).maybeSingle();
  if (!pay) return new Response("unknown", { status: 200 });
  if (pay.statut === "paye") return new Response("already-paid", { status: 200 });

  let confirmed = false, orderId: any = null, paymentId: any = null, paidTotal: number | null = null;
  try {
    const tok = await haToken(cfg);
    if (pay.ha_checkout_intent_id) {
      const r = await fetch(`${HA_API}/v5/organizations/${cfg.org_slug}/checkout-intents/${pay.ha_checkout_intent_id}`, {
        headers: { Authorization: `Bearer ${tok}`, "User-Agent": UA, "Accept": "application/json" },
      });
      if (r.ok) {
        const ci = await r.json();
        const order = ci?.order;
        const pmts = order?.payments;
        if (order && Array.isArray(pmts)) {
          const ok = pmts.find((p: any) => ["Authorized", "Registered"].includes(p.state));
          if (ok) {
            confirmed = true; orderId = order.id; paymentId = ok.id;
            // montant reellement encaisse (centimes) : total de l'order, sinon somme des paiements
            paidTotal = (order?.amount?.total != null)
              ? Number(order.amount.total)
              : pmts.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
          }
        }
      }
    }
  } catch (_) { /* on ne confirme pas */ }

  if (!confirmed) return new Response("not-confirmed", { status: 200 });

  // #6 : le montant encaisse doit egaler le montant du, sinon on NE met PAS "paye"
  const expected = Number(pay.montant_cents);
  const amountOk = paidTotal != null && Math.abs(paidTotal - expected) < 1;
  const newStatut = amountOk ? "paye" : "a_verifier";

  await admin.from("paiements").update({
    statut: newStatut,
    paid_at: new Date().toISOString(),
    ha_order_id: orderId ? String(orderId) : null,
    ha_payment_id: paymentId ? String(paymentId) : null,
    metadata: { ...(pay.metadata || {}), verif: { paid_total_cents: paidTotal, expected_cents: expected, match: amountOk } },
  }).eq("id", pay.id);

  return new Response(amountOk ? "ok" : "amount-mismatch", { status: 200 });
});
