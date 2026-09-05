"""Background scheduler for periodic cleanup."""
from apscheduler.schedulers.background import BackgroundScheduler
from database import delete_old_attachments
from settings import Config

def cleanup_job():
    """Run attachment cleanup."""
    deleted = delete_old_attachments(Config.ATTACHMENT_RETENTION_HOURS)
    print(f"[CLEANUP] Deleted {deleted} old attachments")

def start_scheduler():
    """Start the background scheduler."""
    scheduler = BackgroundScheduler()
    scheduler.add_job(cleanup_job, 'interval', hours=24)  # Run once per day
    scheduler.start()
    print("[SCHEDULER] Started - will clean attachments every 24 hours")