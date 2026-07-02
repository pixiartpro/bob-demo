// helloasso-adhesion : Checkout HelloAsso pour l'ADHESION annuelle (10 EUR FIXE),
// reliee au COMPTE FAMILLE connecte. Montant FIXE cote serveur (jamais depuis le navigateur).
// verify_jwt reste false : on identifie la famille via son access_token (Authorization),
// et on ecrit en service_role. La confirmation passe par le webhook generique helloasso-webhook
// (par metadata.paiement_id) -> aucun changement du webhook necessaire.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HA_API = "https://api.helloasso.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MONTANT_CENTS = 1000; // 10 EUR fixe -- adhesion annuelle du CASE

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Annee d'adhesion : 1er aout -> 31 juillet. Ex. 02/07/2026 => "2025-2026" ; 02/08/2026 => "2026-2027".
function anneeAdhesion(d = new Date()): string {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(); // 0=janv ... 7=aout
  const debut = m >= 7 ? y : y - 1;
  return `${debut}-${debut + 1}`;
}

async function haToken(cfg: any): Promise<string> {
  const r = await fetch(`${HA_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.client_id, client_secret: cfg.client_secret }),
  });
  if (!r.ok) throw new Error(`oauth ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_non_autorisee" }, 405);
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 1) Identifier la famille via son access_token (jamais confiance au corps pour l'identite)
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({ error: "non_connecte" }, 401);
    const { data: uData } = await admin.auth.getUser(jwt);
    const uid = uData?.user?.id;
    if (!uid) return json({ error: "non_connecte" }, 401);

    const { data: prof } = await admin.from("profiles").select("asso_id, statut").eq("id", uid).maybeSingle();
    if (!prof?.asso_id) return json({ error: "profil_absent" }, 403);
    const asso_id = prof.asso_id;
    const annee = anneeAdhesion();

    const b = await req.json().catch(() => ({} as any));
    const retour = (typeof b.retour_url === "string" && b.retour_url.startsWith("https://")) ? b.retour_url : "https://bob.re";
    const sep = retour.includes("?") ? "&" : "?";

    // 2) Deja adherent cette annee ? -> on ne recree pas de paiement
    const { data: dejaP } = await admin.from("paiements")
      .select("id").eq("asso_id", asso_id).eq("user_id", uid).eq("objet", "adhesion")
      .eq("statut", "paye").contains("metadata", { annee }).maybeSingle();
    if (dejaP) return json({ error: "deja_adherent", annee }, 409);

    // 3) Reutiliser un checkout en attente recent (evite les doublons)
    const since = new Date(Date.now() - 14 * 60 * 1000).toISOString();
    const { data: recent } = await admin.from("paiements")
      .select("id, ha_redirect_url, montant_cents").eq("asso_id", asso_id).eq("user_id", uid)
      .eq("objet", "adhesion").eq("statut", "en_attente").contains("metadata", { annee })
      .not("ha_redirect_url", "is", null).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (recent?.ha_redirect_url) return json({ redirectUrl: recent.ha_redirect_url, montant_cents: recent.montant_cents, reuse: true });

    // 4) Creer la ligne de paiement (montant FIXE cote serveur)
    const libelle = `Adhesion ${annee} - CASE du Bois de Nefles`;
    const { data: pay, error: perr } = await admin.from("paiements").insert({
      asso_id, user_id: uid, objet: "adhesion", libelle,
      montant_cents: MONTANT_CENTS, statut: "en_attente",
      metadata: { source: "espace_famille", annee },
    }).select("id").single();
    if (perr || !pay) return json({ error: "creation_paiement", detail: perr?.message }, 500);

    // 5) Checkout HelloAsso (l'argent va direct sur le compte du CASE ; le pourboire eventuel est cote HelloAsso)
    const cfg = (await admin.rpc("helloasso_config")).data as any;
    if (!cfg?.client_id) return json({ error: "config_absente" }, 500);
    const tok = await haToken(cfg);
    const r = await fetch(`${HA_API}/v5/organizations/${cfg.org_slug}/checkout-intents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "User-Agent": UA, "Accept": "application/json" },
      body: JSON.stringify({
        totalAmount: MONTANT_CENTS, initialAmount: MONTANT_CENTS, itemName: libelle,
        backUrl: `${retour}${sep}paiement=annule`, errorUrl: `${retour}${sep}paiement=erreur`,
        returnUrl: `${retour}${sep}paiement=ok&pid=${pay.id}`, containsDonation: false,
        metadata: { paiement_id: pay.id, asso_id, objet: "adhesion", annee },
      }),
    });
    const ci = await r.json().catch(() => ({} as any));
    if (!r.ok || !ci.redirectUrl) {
      await admin.from("paiements").update({ statut: "erreur", metadata: { source: "espace_famille", annee, error: ci } }).eq("id", pay.id);
      return json({ error: "helloasso_checkout", detail: ci }, 502);
    }
    await admin.from("paiements").update({ ha_checkout_intent_id: String(ci.id), ha_redirect_url: ci.redirectUrl }).eq("id", pay.id);
    return json({ paiement_id: pay.id, redirectUrl: ci.redirectUrl, montant_cents: MONTANT_CENTS, annee });
  } catch (e) {
    return json({ error: "exception", detail: String(e) }, 500);
  }
});
