"""Email sending module using Resend (with SMTP fallback)."""
import resend
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from settings import Config

# Resend API key
if Config.RESEND_API_KEY:
    resend.api_key = Config.RESEND_API_KEY
else:
    print("[VEYRONIS] WARNING: RESEND_API_KEY not set. Email will fall back to SMTP if configured.")

# The sender MUST be a verified sender in Resend
SENDER_EMAIL = "mishobazadze@gmail.com"


def send_smtp_email(to_email: str, subject: str, html_content: str) -> bool:
    """
    Send email via SMTP (Gmail or other SMTP server).
    Uses Config.SMTP_USER, Config.SMTP_PASSWORD, Config.SMTP_HOST, Config.SMTP_PORT.
    """
    if not Config.smtp_ready():
        print("[SMTP] SMTP not configured. Skipping.")
        return False

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = Config.SMTP_USER
        msg["To"] = to_email

        # Attach HTML version
        msg.attach(MIMEText(html_content, "html"))

        with smtplib.SMTP(Config.SMTP_HOST, Config.SMTP_PORT) as server:
            server.starttls()
            server.login(Config.SMTP_USER, Config.SMTP_PASSWORD)
            server.send_message(msg)

        print(f"[SMTP] Sent to {to_email}")
        return True
    except Exception as e:
        print(f"[SMTP ERROR] {e}")
        import traceback
        traceback.print_exc()
        return False


def send_email(to_email: str, subject: str, html_content: str) -> bool:
    """
    Send email using Resend (primary), fallback to SMTP if Resend fails or is not configured.
    """
    # Try Resend first
    if Config.RESEND_API_KEY:
        try:
            result = resend.Emails.send({
                "from": SENDER_EMAIL,
                "to": [to_email],
                "subject": subject,
                "html": html_content
            })
            print(f"[EMAIL] Sent via Resend to {to_email} | Response: {result}")
            return True
        except Exception as e:
            print(f"[EMAIL ERROR] Resend failed: {e}")
            import traceback
            traceback.print_exc()
            # Fall through to SMTP

    # Fallback to SMTP
    if Config.smtp_ready():
        print(f"[EMAIL] Falling back to SMTP for {to_email}")
        return send_smtp_email(to_email, subject, html_content)

    print(f"[EMAIL] No email method available. Failed to send to {to_email}")
    return False


def send_reset_email(email: str, token: str, base_url: str) -> bool:
    """Send password reset email."""
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
    """Send email verification link."""
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
    """Send user feedback to admin."""
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