"""Background scheduler for periodic cleanup and usage flush."""
from apscheduler.schedulers.background import BackgroundScheduler
from database import delete_old_attachments
from settings import Config

def cleanup_job():
    """Run attachment cleanup."""
    deleted = delete_old_attachments(Config.ATTACHMENT_RETENTION_HOURS)
    print(f"[CLEANUP] Deleted {deleted} old attachments")

def usage_flush_job():
    """Flush in-memory usage deltas to Neon."""
    try:
        from usage_cache import usage_cache
        users, msgs = usage_cache.flush()
        if users:
            print(f"[USAGE FLUSH] {msgs} messages across {users} users")
    except Exception as e:
        print(f"[USAGE FLUSH ERROR] {e}")

def start_scheduler():
    """Start the background scheduler."""
    scheduler = BackgroundScheduler()
    scheduler.add_job(cleanup_job, 'interval', hours=24)
    scheduler.add_job(usage_flush_job, 'interval', seconds=60)
    scheduler.start()
    print("[SCHEDULER] Started — cleanup (24h), usage flush (60s)")