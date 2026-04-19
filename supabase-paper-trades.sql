-- ══════════════════════════════════════════════
-- BetAnalytics — Paper Trading Schema
-- Run in Supabase → SQL Editor → New query
-- ══════════════════════════════════════════════

-- Paper trades table — every pick the model generates
CREATE TABLE IF NOT EXISTS paper_trades (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    -- Game info
    game_id         TEXT,               -- MLB statsapi gamePk
    sport           TEXT DEFAULT 'mlb',
    home_team       TEXT NOT NULL,
    away_team       TEXT NOT NULL,
    game_date       TEXT,               -- YYYY-MM-DD
    game_time       TIMESTAMPTZ,        -- scheduled start

    -- Pick details
    market          TEXT NOT NULL,       -- Moneyline, Total, Run Line, NRFI, F5 ML, etc.
    selection       TEXT NOT NULL,       -- "Yankees", "Over 8.5", "NRFI", etc.
    pick_type       TEXT,               -- principal, totales, especial, alternativo, player

    -- Odds at time of pick
    odds_at_pick    TEXT,               -- american odds string e.g. "-150"
    odds_decimal    NUMERIC,            -- decimal odds
    implied_prob    NUMERIC,            -- implied probability from odds (0-1)

    -- Model outputs
    model_prob      NUMERIC,            -- our model probability (0-1)
    ev              NUMERIC,            -- expected value (model_prob * decimal - 1)
    ev_percent      NUMERIC,            -- EV as percentage
    edge            NUMERIC,            -- model_prob - implied_prob
    edge_percent    NUMERIC,            -- edge as percentage
    kelly           NUMERIC,            -- kelly fraction %
    confidence      NUMERIC,            -- pick confidence (0-100)

    -- Pitcher info
    home_pitcher    TEXT,
    away_pitcher    TEXT,
    home_pq         NUMERIC,            -- pitcher quality index
    away_pq         NUMERIC,

    -- Poisson outputs
    x_runs_home     NUMERIC,
    x_runs_away     NUMERIC,
    model_total     NUMERIC,
    model_spread    NUMERIC,

    -- Closing line (filled by cron BEFORE game starts)
    odds_at_close   TEXT,               -- american odds at close
    close_decimal   NUMERIC,            -- decimal odds at close
    close_implied   NUMERIC,            -- implied prob at close
    close_captured_at TIMESTAMPTZ,

    -- CLV (computed after close is captured)
    clv_cents       NUMERIC,            -- close_implied - pick_implied (× 100)
    clv_percent     NUMERIC,            -- (pick_decimal / close_decimal - 1) × 100

    -- Resolution (filled by cron AFTER game ends)
    status          TEXT DEFAULT 'pending',  -- pending, won, lost, push, void
    actual_home_score INTEGER,
    actual_away_score INTEGER,
    resolved_at     TIMESTAMPTZ,

    -- Simulated P&L (assuming $100 flat bet)
    profit          NUMERIC DEFAULT 0,  -- +$90 or -$100 etc.

    -- Metadata
    model_version   TEXT DEFAULT '3.0',
    metadata        JSONB DEFAULT '{}'
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_pt_status ON paper_trades(status);
CREATE INDEX IF NOT EXISTS idx_pt_sport ON paper_trades(sport);
CREATE INDEX IF NOT EXISTS idx_pt_game_id ON paper_trades(game_id);
CREATE INDEX IF NOT EXISTS idx_pt_created ON paper_trades(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pt_market ON paper_trades(market);
CREATE INDEX IF NOT EXISTS idx_pt_game_date ON paper_trades(game_date);
CREATE INDEX IF NOT EXISTS idx_pt_edge ON paper_trades(edge_percent DESC);

-- No RLS on this table — it's system-level, not user-specific
-- The cron jobs need to read/write without auth

-- ══════════════════════════════════════════════
-- View: CLV Performance Dashboard
-- ══════════════════════════════════════════════

CREATE OR REPLACE VIEW v_clv_dashboard AS
SELECT
    -- Overall
    COUNT(*) AS total_picks,
    COUNT(*) FILTER (WHERE status IN ('won','lost')) AS resolved,
    COUNT(*) FILTER (WHERE status = 'won') AS won,
    COUNT(*) FILTER (WHERE status = 'lost') AS lost,

    -- Win rate
    ROUND(
        COUNT(*) FILTER (WHERE status = 'won')::NUMERIC /
        NULLIF(COUNT(*) FILTER (WHERE status IN ('won','lost')), 0) * 100, 1
    ) AS win_rate,

    -- CLV
    COUNT(*) FILTER (WHERE clv_cents IS NOT NULL) AS clv_measured,
    ROUND(AVG(clv_cents) FILTER (WHERE clv_cents IS NOT NULL), 2) AS avg_clv_cents,
    ROUND(
        COUNT(*) FILTER (WHERE clv_cents > 0)::NUMERIC /
        NULLIF(COUNT(*) FILTER (WHERE clv_cents IS NOT NULL), 0) * 100, 1
    ) AS positive_clv_pct,

    -- EV
    ROUND(AVG(ev_percent), 2) AS avg_ev_percent,
    ROUND(AVG(edge_percent), 2) AS avg_edge_percent,

    -- P&L (simulated $100 flat)
    ROUND(SUM(profit) FILTER (WHERE status IN ('won','lost')), 2) AS total_profit,
    ROUND(
        SUM(profit) FILTER (WHERE status IN ('won','lost'))::NUMERIC /
        NULLIF(COUNT(*) FILTER (WHERE status IN ('won','lost')) * 100, 0) * 100, 1
    ) AS roi_pct

FROM paper_trades;

-- ══════════════════════════════════════════════
-- View: CLV by Market
-- ══════════════════════════════════════════════

CREATE OR REPLACE VIEW v_clv_by_market AS
SELECT
    market,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status = 'won') AS won,
    ROUND(
        COUNT(*) FILTER (WHERE status = 'won')::NUMERIC /
        NULLIF(COUNT(*) FILTER (WHERE status IN ('won','lost')), 0) * 100, 1
    ) AS win_rate,
    ROUND(AVG(clv_cents) FILTER (WHERE clv_cents IS NOT NULL), 2) AS avg_clv,
    ROUND(AVG(ev_percent), 2) AS avg_ev,
    ROUND(SUM(profit) FILTER (WHERE status IN ('won','lost')), 2) AS profit
FROM paper_trades
GROUP BY market
ORDER BY avg_clv DESC NULLS LAST;
