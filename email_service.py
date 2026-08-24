"""Email sending module using Resend."""
import resend
from settings import Config

# Only configure if API key is set
if Config.RESEND_API_KEY:
    resend.api_key = Config.RESEND_API_KEY

def send_reset_email(email: str, token: str, base_url: str) -> bool:
    """Send password reset email with a secure link."""
    reset_link = f"{base_url}/reset-password?token={token}"
    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0a0a0c; color: #f0f0f5;">
        <div style="background: #1a1a2e; padding: 30px; border-radius: 16px; border: 1px solid rgba(167,139,250,0.2);">
            <h1 style="color: #a78bfa; margin-top: 0;">Reset Your Password</h1>
            <p style="color: #a0a0b8;">You requested to reset your password for VEYRONIS.</p>
            <p style="margin: 24px 0;">
                <a href="{reset_link}" style="display: inline-block; background: linear-gradient(135deg, #a78bfa, #818cf8); color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Reset Password</a>
            </p>
            <p style="color: #6e6e8a; font-size: 14px;">This link expires in <strong>1 hour</strong>.</p>
            <p style="color: #6e6e8a; font-size: 14px;">If you didn't request this, please ignore this email.</p>
            <hr style="border-color: rgba(167,139,250,0.1); margin: 20px 0;">
            <p style="color: #6e6e8a; font-size: 12px;">VEYRONIS — Multi-AI Student Assistant</p>
        </div>
    </body>
    </html>
    """
    try:
        resend.Emails.send({
            "from": "VEYRONIS <onboarding@resend.dev>",
            "to": [email],
            "subject": "Reset Your VEYRONIS Password",
            "html": html_content
        })
        return True
    except Exception as e:
        print(f"[EMAIL ERROR] {e}")
        return False

def send_verification_email(email: str, token: str, base_url: str) -> bool:
    """Send email verification link to new users."""
    verify_link = f"{base_url}/verify-email?token={token}"
    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0a0a0c; color: #f0f0f5;">
        <div style="background: #1a1a2e; padding: 30px; border-radius: 16px; border: 1px solid rgba(167,139,250,0.2);">
            <h1 style="color: #a78bfa; margin-top: 0;">Verify Your Email</h1>
            <p style="color: #a0a0b8;">Welcome to VEYRONIS!</p>
            <p style="margin: 24px 0;">
                <a href="{verify_link}" style="display: inline-block; background: linear-gradient(135deg, #a78bfa, #818cf8); color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Verify Email</a>
            </p>
            <p style="color: #6e6e8a; font-size: 14px;">This link expires in <strong>24 hours</strong>.</p>
            <hr style="border-color: rgba(167,139,250,0.1); margin: 20px 0;">
            <p style="color: #6e6e8a; font-size: 12px;">VEYRONIS — Multi-AI Student Assistant</p>
        </div>
    </body>
    </html>
    """
    try:
        resend.Emails.send({
            "from": "VEYRONIS <onboarding@resend.dev>",
            "to": [email],
            "subject": "Verify Your VEYRONIS Email",
            "html": html_content
        })
        return True
    except Exception as e:
        print(f"[EMAIL ERROR] {e}")
        return False