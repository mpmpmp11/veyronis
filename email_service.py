"""Email sending module using Resend (with verified sender)."""
import resend
from settings import Config

# Resend API key
if Config.RESEND_API_KEY:
    resend.api_key = Config.RESEND_API_KEY
else:
    print("[VEYRONIS] WARNING: RESEND_API_KEY not set. Email disabled.")

# The sender MUST be a verified sender in Resend
SENDER_EMAIL = "mishobazadze@gmail.com"  # <-- THIS MUST BE YOUR EMAIL

def send_email(to_email: str, subject: str, html_content: str) -> bool:
    try:
        result = resend.Emails.send({
            "from": SENDER_EMAIL,
            "to": [to_email],
            "subject": subject,
            "html": html_content
        })
        print(f"[EMAIL] Sent to {to_email} | Response: {result}")
        return True
    except Exception as e:
        print(f"[EMAIL ERROR] {e}")
        import traceback
        traceback.print_exc()
        return False

def send_reset_email(email: str, token: str, base_url: str) -> bool:
    reset_link = f"{base_url}/reset-password?token={token}"
    html = f"""
    <html><body style="font-family:Arial;background:#0a0a0c;color:#f0f0f5;padding:20px;">
        <div style="background:#1a1a2e;padding:30px;border-radius:16px;border:1px solid rgba(167,139,250,0.2);">
            <h1 style="color:#a78bfa;">Reset Your Password</h1>
            <p style="color:#a0a0b8;">Click the link below to reset your VEYRONIS password:</p>
            <p style="margin:24px 0;">
                <a href="{reset_link}" style="background:linear-gradient(135deg,#a78bfa,#818cf8);color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Reset Password</a>
            </p>
            <p style="color:#6e6e8a;font-size:14px;">This link expires in 1 hour.</p>
            <hr style="border-color:rgba(167,139,250,0.1);margin:20px 0;">
            <p style="color:#6e6e8a;font-size:12px;">VEYRONIS — Multi-AI Student Assistant</p>
        </div>
    </body></html>
    """
    return send_email(email, "Reset Your VEYRONIS Password", html)

def send_verification_email(email: str, token: str, base_url: str) -> bool:
    verify_link = f"{base_url}/verify-email?token={token}"
    html = f"""
    <html><body style="font-family:Arial;background:#0a0a0c;color:#f0f0f5;padding:20px;">
        <div style="background:#1a1a2e;padding:30px;border-radius:16px;border:1px solid rgba(167,139,250,0.2);">
            <h1 style="color:#a78bfa;">Verify Your Email</h1>
            <p style="color:#a0a0b8;">Welcome to VEYRONIS! Click the link below to verify your email:</p>
            <p style="margin:24px 0;">
                <a href="{verify_link}" style="background:linear-gradient(135deg,#a78bfa,#818cf8);color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Verify Email</a>
            </p>
            <p style="color:#6e6e8a;font-size:14px;">This link expires in 24 hours.</p>
            <hr style="border-color:rgba(167,139,250,0.1);margin:20px 0;">
            <p style="color:#6e6e8a;font-size:12px;">VEYRONIS — Multi-AI Student Assistant</p>
        </div>
    </body></html>
    """
    return send_email(email, "Verify Your VEYRONIS Email", html)