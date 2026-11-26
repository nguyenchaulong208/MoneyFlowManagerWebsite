import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeAppUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("PUBLIC_APP_URL must use HTTPS.");
  }
  url.search = "";
  url.hash = "";
  return url;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response(405, { error: "Method not allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("INVITE_FROM_EMAIL");
  const publicAppUrl = Deno.env.get("PUBLIC_APP_URL");
  if (!supabaseUrl || !anonKey || !resendKey || !fromEmail || !publicAppUrl) {
    return response(500, { error: "Invitation email is not configured. Contact the project owner." });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return response(401, { error: "Sign in before sending an invitation." });

  let supabase: ReturnType<typeof createClient> | null = null;
  let inviteToken: string | null = null;
  let failureStatus = 400;
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const spaceId = typeof body.spaceId === "string" ? body.spaceId : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !/^[0-9a-f-]{36}$/i.test(spaceId)) {
      return response(400, { error: "A valid email address and family space are required." });
    }

    supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData.user) return response(401, { error: "Your session is invalid or expired. Sign in again." });

    const { data: token, error: inviteError } = await supabase.rpc("create_space_invite", {
      p_space_id: spaceId,
      p_email: email,
    });
    if (inviteError) return response(403, { error: inviteError.message });
    inviteToken = token;
    failureStatus = 502;

    const inviteUrl = safeAppUrl(publicAppUrl);
    inviteUrl.hash = new URLSearchParams({ invite: token }).toString();
    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: "Lời mời tham gia không gian tài chính gia đình",
        text: `Bạn được mời tham gia không gian tài chính gia đình trên Dòng Tiền. Đăng nhập bằng email ${email} đã được xác nhận rồi mở liên kết này để tham gia:\n\n${inviteUrl.href}\n\nLiên kết chỉ dùng một lần và hết hạn sau 7 ngày. Nếu bạn không mong đợi lời mời này, hãy bỏ qua email.`,
      }),
    });
    if (!emailResponse.ok) throw new Error("Invitation email provider rejected the request.");
    return response(200, { sent: true });
  } catch (error) {
    if (supabase && inviteToken) {
      const { error: revokeError } = await supabase.rpc("revoke_space_invite", { p_invite_id: null, p_token: inviteToken });
      if (revokeError) return response(500, { error: "Email delivery failed and the pending invitation could not be revoked. Contact the project owner." });
    }
    return response(failureStatus, {
      error: failureStatus === 502
        ? "Không gửi được email mời. Lời mời đã bị thu hồi; hãy thử lại hoặc tạo liên kết chia sẻ."
        : error instanceof Error ? error.message : "Invitation could not be sent.",
    });
  }
});
