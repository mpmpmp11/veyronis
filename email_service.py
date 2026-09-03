"""Email sending via Brevo (free, no domain required)."""
import os
import requests
from settings import Config

# Brevo API endpoint
BREVO_URL = "https://api.brevo.com/v3/smtp/email"

# Sender – use your verified email (the one you signed up with)
SENDER_EMAIL = "mishobazadze@gmail.com"
SENDER_NAME = "VEYRONIS"


def send_brevo_email(to_email: str, subject: str, html_content: str) -> bool:
    """Send email using Brevo API. Returns True on success, False on failure."""
    if not Config.BREVO_API_KEY:
        print("[BREVO] API key missing.")
        return False

    headers = {
        "api-key": Config.BREVO_API_KEY,
        "Content-Type": "application/json",
    }

    payload = {
        "sender": {"email": SENDER_EMAIL, "name": SENDER_NAME},
        "to": [{"email": to_email}],
        "subject": subject,
        "htmlContent": html_content,
    }

    try:
        resp = requests.post(BREVO_URL, headers=headers, json=payload, timeout=10)
        if resp.status_code in (200, 201):
            print(f"[BREVO] ✅ Email sent to {to_email}")
            return True
        else:
            print(f"[BREVO] ❌ Error {resp.status_code}: {resp.text}")
            return False
    except Exception as e:
        print(f"[BREVO] ❌ Exception: {e}")
        return False


def send_email(to_email: str, subject: str, html_content: str) -> bool:
    """
    Main entry point. Uses Brevo (primary).
    Returns True if sent, False otherwise.
    """
    return send_brevo_email(to_email, subject, html_content)


# ─── Convenience functions for VEYRONIS ───

def send_reset_email(email: str, token: str, base_url: str) -> bool:
    reset_link = f"{base_url}/#reset-password?token={token}"  # ← Added #
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


def send_feedback_email(to_admin: str, from_user: str, message: str) -> bool:
    html = f"""
    <html><body style="font-family:Arial;background:#0a0a0c;color:#f0f0f5;padding:20px;">
        <div style="background:#1a1a2e;padding:30px;border-radius:16px;border:1px solid rgba(167,139,250,0.2);">
            <h1 style="color:#a78bfa;">📨 New Feedback</h1>
            <p><strong style="color:#f0f0f5;">From:</strong> <span style="color:#a0a0b8;">{from_user}</span></p>
            <p><strong style="color:#f0f0f5;">Message:</strong></p>
            <p style="background:rgba(255,255,255,0.05);padding:16px;border-radius:8px;color:#a0a0b8;line-height:1.6;white-space:pre-wrap;">{message}</p>
            <hr style="border-color:rgba(167,139,250,0.1);margin:20px 0;">
            <p style="color:#6e6e8a;font-size:12px;">VEYRONIS — Multi-AI Student Assistant</p>
        </div>
    </body></html>
    """
    subject = f"📨 VEYRONIS Feedback from {from_user}"
    return send_email(to_admin, subject, html)