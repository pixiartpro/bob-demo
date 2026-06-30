// Cree un Checkout HelloAsso pour une inscription periscolaire, a partir du JETON du lien.
// Montant LU cote serveur (montant_du_cents verrouille) -> jamais depuis le navigateur. verify_jwt=false (auth = jeton).
// v4 (30/06/2026) : ajout d'un plafond anti-faute-de-frappe (#15 de l'audit).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HA_API = "https://api.helloasso.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PLAFOND_CENTS = 200000; // 2000 € : au-dela = quasi surement une erreur de saisie -> on refuse

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

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
    const b = await req.json().catch(() => ({} as any));
    const token = String(b.pay_token ?? "").trim();
    if (token.length < 20) return json({ error: "token_absent" }, 400);
    const retour = (typeof b.retour_url === "string" && b.retour_url.startsWith("https://")) ? b.retour_url : "https://bob.re";
    const sep = retour.includes("?") ? "&" : "?";  // <-- correctif : evite le double '?'

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: insc } = await admin.from("inscriptions_periscolaire")
      .select("id, asso_id, user_id, annee, montant_du_cents").eq("pay_token", token).maybeSingle();
    if (!insc || !insc.montant_du_cents || insc.montant_du_cents < 100)
      return json({ error: "lien_invalide" }, 404);
    if (insc.montant_du_cents > PLAFOND_CENTS)  // #15 garde-fou : montant aberrant -> refus
      return json({ error: "montant_trop_eleve" }, 422);

    const { data: dejaP } = await admin.from("paiements")
      .select("id").eq("inscription_periscolaire_id", insc.id).eq("statut", "paye").maybeSingle();
    if (dejaP) return json({ error: "deja_paye" }, 409);

    const since = new Date(Date.now() - 14 * 60 * 1000).toISOString();
    const { data: recent } = await admin.from("paiements")
      .select("id, ha_redirect_url, montant_cents").eq("inscription_periscolaire_id", insc.id)
      .eq("statut", "en_attente").not("ha_redirect_url", "is", null)
      .gte("created_at", since).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (recent?.ha_redirect_url) return json({ redirectUrl: recent.ha_redirect_url, montant_cents: recent.montant_cents, reuse: true });

    const montant_cents = insc.montant_du_cents;
    const libelle = `Periscolaire ${insc.annee} - CASE du Bois de Nefles`;

    const { data: pay, error: perr } = await admin.from("paiements").insert({
      asso_id: insc.asso_id, user_id: insc.user_id, inscription_periscolaire_id: insc.id,
      objet: "periscolaire", libelle, montant_cents, statut: "en_attente", metadata: { source: "lien" },
    }).select("id").single();
    if (perr || !pay) return json({ error: "creation_paiement", detail: perr?.message }, 500);

    const cfg = (await admin.rpc("helloasso_config")).data as any;
    if (!cfg?.client_id) return json({ error: "config_absente" }, 500);
    const tok = await haToken(cfg);
    const r = await fetch(`${HA_API}/v5/organizations/${cfg.org_slug}/checkout-intents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "User-Agent": UA, "Accept": "application/json" },
      body: JSON.stringify({
        totalAmount: montant_cents, initialAmount: montant_cents, itemName: libelle,
        backUrl: `${retour}${sep}paiement=annule`, errorUrl: `${retour}${sep}paiement=erreur`,
        returnUrl: `${retour}${sep}paiement=ok&pid=${pay.id}`, containsDonation: false,
        metadata: { paiement_id: pay.id, asso_id: insc.asso_id, objet: "periscolaire" },
      }),
    });
    const ci = await r.json().catch(() => ({} as any));
    if (!r.ok || !ci.redirectUrl) {
      await admin.from("paiements").update({ statut: "erreur", metadata: { error: ci } }).eq("id", pay.id);
      return json({ error: "helloasso_checkout", detail: ci }, 502);
    }
    await admin.from("paiements").update({ ha_checkout_intent_id: String(ci.id), ha_redirect_url: ci.redirectUrl }).eq("id", pay.id);
    return json({ paiement_id: pay.id, redirectUrl: ci.redirectUrl, montant_cents });
  } catch (e) {
    return json({ error: "exception", detail: String(e) }, 500);
  }
});
