// Webhook HelloAsso : appele quand un paiement change d'etat. Gate par ?token= (Vault).
// 🔴 CHAINE VIVANTE ET PARTAGEE : ce webhook confirme les paiements des DEUX canaux
//    (adhesion ET periscolaire). Toute retouche doit laisser le chemin heureux INTACT.
// Re-verifie TOUJOURS le checkout directement chez HelloAsso (jamais confiance au corps brut).
// v3 (30/06/2026) : compare le montant REELLEMENT encaisse au montant DU (#6 de l'audit).
//   -> si egal : "paye" ; si different : "a_verifier" (jamais "paye" sur un montant qui ne colle pas).
// v7 (30/08/2026, apres relecture adverse du rallumage periscolaire) :
//   - l'UPDATE final est VERIFIE : s'il echoue (ex. index unique du canal en ligne,
//     migration 88 — un double paiement en ligne REEL), la ligne est posee en
//     'a_verifier' avec le motif, et si meme cela echoue on repond 500 pour que
//     HelloAsso re-notifie. Avant : l'erreur etait avalee, reponse « ok », et un
//     paiement encaisse chez HelloAsso restait 'en_attente' pour toujours ;
//   - un echec de LECTURE chez HelloAsso (oauth/reseau) repond 503 (re-notifiable)
//     au lieu de 200 « not-confirmed » qui perdait l'evenement ;
//   - garde inter-canaux (periscolaire) : si le du est DEJA couvert par d'autres
//     encaissements 'paye' (ex. la famille a paye au comptoir entre le clic et le
//     webhook), la ligne passe en 'a_verifier' (trop-percu VISIBLE et remboursable),
//     jamais en 'paye' silencieux.
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
  // v7 : une CONFIG illisible n'est pas un jeton faux — 503 (re-notifiable),
  // jamais 403 (que HelloAsso ne rejoue pas).
  const rcfg = await admin.rpc("helloasso_config").then((x: any) => x, (e: any) => ({ data: null, error: e }));
  if (rcfg.error) return new Response("config-unavailable", { status: 503 });
  const cfg: any = rcfg.data;

  const url = new URL(req.url);
  if (!cfg?.webhook_token || url.searchParams.get("token") !== cfg.webhook_token)
    return new Response("forbidden", { status: 403 });

  let body: any = {};
  try { body = await req.json(); } catch (_) { /* ignore */ }

  const meta = body?.metadata ?? body?.data?.metadata ?? {};
  const paiement_id = meta?.paiement_id;
  if (!paiement_id) return new Response("no-metadata", { status: 200 });

  const { data: pay, error: epay } = await admin.from("paiements").select("*").eq("id", paiement_id).maybeSingle();
  // v7 : un echec de LECTURE n'est pas « ligne inconnue » — 503, l'evenement se rejoue.
  if (epay) return new Response("verify-failed", { status: 503 });
  if (!pay) return new Response("unknown", { status: 200 });
  if (pay.statut === "paye") return new Response("already-paid", { status: 200 });
  // Ligne sans intent (jamais partie chez HelloAsso) : rien a verifier, et pas
  // d'appel oauth gaspille (2e passe adverse).
  if (!pay.ha_checkout_intent_id) return new Response("not-confirmed", { status: 200 });

  let confirmed = false, orderId: any = null, paymentId: any = null, paidTotal: number | null = null;
  let fetchFailed = false;
  try {
    const tok = await haToken(cfg);
    {
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
      } else if (r.status === 404) {
        // 404 = reponse DEFINITIVE (intent inconnu/purge) : re-notifier en boucle
        // ne changera rien — on acquitte en non-confirme (2e passe adverse).
        fetchFailed = false;
      } else {
        fetchFailed = true; // 5xx/429 : transitoire, re-notifiable
      }
    }
  } catch (_) { fetchFailed = true; }

  // v7 : un echec de LECTURE ne vaut pas « non confirme » — on demande le rejeu.
  if (!confirmed && fetchFailed) return new Response("verify-failed", { status: 503 });
  if (!confirmed) return new Response("not-confirmed", { status: 200 });

  // #6 : le montant encaisse doit egaler le montant du, sinon on NE met PAS "paye"
  const expected = Number(pay.montant_cents);
  const amountOk = paidTotal != null && Math.abs(paidTotal - expected) < 1;
  let newStatut = amountOk ? "paye" : "a_verifier";
  let motif: string | null = amountOk ? null : "ecart_montant";

  // v7 : garde inter-canaux (periscolaire uniquement) — si le du est deja couvert
  // par d'autres lignes 'paye' (comptoir pendant que le checkout etait ouvert),
  // ce paiement est un TROP-PERCU : 'a_verifier', visible, remboursable.
  if (newStatut === "paye" && (pay.dossier_id || pay.inscription_periscolaire_id)) {
    const orKeys = [
      pay.dossier_id ? `dossier_id.eq.${pay.dossier_id}` : null,
      pay.inscription_periscolaire_id ? `inscription_periscolaire_id.eq.${pay.inscription_periscolaire_id}` : null,
    ].filter(Boolean).join(",");
    const { data: autres, error: eaut } = await admin.from("paiements")
      .select("id, montant_cents").eq("statut", "paye").or(orKeys);
    if (eaut) return new Response("verify-failed", { status: 503 });
    const dejaNet = (autres ?? []).reduce((s: number, p: any) => s + (Number(p.montant_cents) || 0), 0);
    if (dejaNet >= expected) { newStatut = "a_verifier"; motif = "deja_couvert_au_comptoir"; }
  }

  const patch: any = {
    statut: newStatut,
    paid_at: new Date().toISOString(),
    ha_order_id: orderId ? String(orderId) : null,
    ha_payment_id: paymentId ? String(paymentId) : null,
    metadata: { ...(pay.metadata || {}), verif: { paid_total_cents: paidTotal, expected_cents: expected, match: amountOk, ...(motif ? { motif } : {}) } },
  };
  const { error: eup } = await admin.from("paiements").update(patch).eq("id", pay.id);
  if (eup) {
    // v7 : l'ecriture 'paye' peut violer l'index unique du canal en ligne
    // (double paiement en ligne REEL, migration 88). On rend le trop-percu
    // VISIBLE en 'a_verifier' ; si meme cela echoue, 500 -> HelloAsso rejoue.
    const { error: efb } = await admin.from("paiements").update({
      ...patch, statut: "a_verifier",
      metadata: { ...patch.metadata, verif: { ...patch.metadata.verif, motif: "conflit_ecriture", erreur: String(eup.message || "").slice(0, 200) } },
    }).eq("id", pay.id);
    if (efb) return new Response("write-failed", { status: 500 });
    return new Response("conflict-a-verifier", { status: 200 });
  }

  return new Response(amountOk ? "ok" : "amount-mismatch", { status: 200 });
});
