"""
BetAnalytics — Alert Service

Subscribes to SNS and delivers formatted alerts to:
  - Telegram
  - Discord
  - Custom webhooks

Each alert includes: game, market, selection, odds, EV, Kelly, grade.
"""
import json
import os
import asyncio

import aiohttp
import boto3
import structlog

logger = structlog.get_logger()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
CUSTOM_WEBHOOK_URLS = os.getenv("CUSTOM_WEBHOOK_URLS", "").split(",")
SNS_TOPIC_ARN = os.getenv("SNS_TOPIC_ARN", "")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")


GRADE_EMOJI = {"A+": "🔥", "A": "✅", "B+": "📊", "B": "📈", "C": "📉"}


def format_telegram(pick: dict) -> str:
    """Format pick for Telegram (Markdown)."""
    emoji = GRADE_EMOJI.get(pick.get("grade", "C"), "📊")
    return (
        f"{emoji} *Grade {pick['grade']}* — {pick['market'].upper()}\n\n"
        f"🏟 *{pick['game']}*\n"
        f"📌 {pick['selection'].upper()}"
        f"{f' ({pick[\"line\"]})' if pick.get('line') else ''}\n"
        f"📖 {pick['book']} @ `{pick['odds']}`\n\n"
        f"📊 EV: *{pick['ev']}* | Edge: *{pick['edge']}*\n"
        f"💰 Kelly: {pick['kelly']} → *{pick['bet_size']}*\n"
        f"🎯 Confidence: {pick['confidence']:.0%}\n"
        f"{'🦈 Sharp: ' + pick['sharp'] if pick.get('sharp', 'none') != 'none' else ''}"
    )


def format_discord(pick: dict) -> dict:
    """Format pick for Discord embed."""
    emoji = GRADE_EMOJI.get(pick.get("grade", "C"), "📊")
    color = {"A+": 0xFF4500, "A": 0x00FF00, "B+": 0x1E90FF, "B": 0x4169E1}.get(pick.get("grade"), 0x808080)

    return {
        "embeds": [{
            "title": f"{emoji} {pick['grade']} — {pick['market'].upper()} {pick['selection'].upper()}",
            "description": f"**{pick['game']}**",
            "color": color,
            "fields": [
                {"name": "Book", "value": pick["book"], "inline": True},
                {"name": "Odds", "value": str(pick["odds"]), "inline": True},
                {"name": "EV", "value": pick["ev"], "inline": True},
                {"name": "Edge", "value": pick["edge"], "inline": True},
                {"name": "Kelly", "value": pick["kelly"], "inline": True},
                {"name": "Bet Size", "value": pick["bet_size"], "inline": True},
                {"name": "Confidence", "value": f"{pick['confidence']:.0%}", "inline": True},
            ],
            "footer": {"text": "BetAnalytics Quant Engine"},
        }]
    }


async def send_telegram(text: str):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    async with aiohttp.ClientSession() as session:
        await session.post(url, json={
            "chat_id": TELEGRAM_CHAT_ID,
            "text": text,
            "parse_mode": "Markdown",
        })


async def send_discord(embed: dict):
    if not DISCORD_WEBHOOK_URL:
        return
    async with aiohttp.ClientSession() as session:
        await session.post(DISCORD_WEBHOOK_URL, json=embed)


async def send_webhooks(pick: dict):
    async with aiohttp.ClientSession() as session:
        for url in CUSTOM_WEBHOOK_URLS:
            if url.strip():
                try:
                    await session.post(url.strip(), json=pick, timeout=aiohttp.ClientTimeout(total=10))
                except Exception as e:
                    logger.error("webhook_error", url=url, error=str(e))


async def process_alert(message: dict):
    """Process a single SNS alert message."""
    pick = message.get("pick", {})
    if not pick:
        return

    logger.info("alert_received", game=pick.get("game"), grade=pick.get("grade"), ev=pick.get("ev"))

    # Send to all channels in parallel
    await asyncio.gather(
        send_telegram(format_telegram(pick)),
        send_discord(format_discord(pick)),
        send_webhooks(pick),
        return_exceptions=True,
    )


def poll_sqs():
    """
    Alternative: poll SQS queue (SNS → SQS subscription).
    Use this when running as a long-lived ECS service.
    """
    sqs = boto3.client("sqs", region_name=AWS_REGION)
    queue_url = os.getenv("ALERTS_SQS_QUEUE_URL", "")
    if not queue_url:
        logger.error("no_sqs_queue_url")
        return

    logger.info("alert_service_starting", queue=queue_url)

    while True:
        try:
            resp = sqs.receive_message(
                QueueUrl=queue_url,
                MaxNumberOfMessages=10,
                WaitTimeSeconds=20,  # long polling
            )

            for msg in resp.get("Messages", []):
                try:
                    body = json.loads(msg["Body"])
                    # SNS wraps the message
                    if "Message" in body:
                        alert = json.loads(body["Message"])
                    else:
                        alert = body

                    asyncio.run(process_alert(alert))

                    sqs.delete_message(
                        QueueUrl=queue_url,
                        ReceiptHandle=msg["ReceiptHandle"],
                    )
                except Exception as e:
                    logger.error("message_process_error", error=str(e))

        except Exception as e:
            logger.error("sqs_poll_error", error=str(e))
            import time
            time.sleep(5)


if __name__ == "__main__":
    poll_sqs()
