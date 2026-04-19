-- ══════════════════════════════════════════════
-- BetAnalytics — PostgreSQL Schema
-- ══════════════════════════════════════════════

-- Picks (core table — every approved bet)
CREATE TABLE IF NOT EXISTS picks (
    pick_id         TEXT PRIMARY KEY,
    event_id        TEXT NOT NULL,
    sport           TEXT NOT NULL DEFAULT 'mlb',
    home_team       TEXT NOT NULL,
    away_team       TEXT NOT NULL,
    -- Pick details
    market          TEXT NOT NULL,       -- moneyline, total, run_line, f5_ml, nrfi
    selection       TEXT NOT NULL,       -- home, away, over, under, nrfi, yrfi
    line            NUMERIC,             -- spread/total value
    book            TEXT NOT NULL,       -- which sportsbook
    odds_decimal    NUMERIC NOT NULL,
    odds_american   INTEGER NOT NULL,
    -- Model outputs
    model_prob      NUMERIC NOT NULL,
    implied_prob    NUMERIC NOT NULL,
    ev              NUMERIC NOT NULL,
    ev_percent      NUMERIC NOT NULL,
    edge_percent    NUMERIC NOT NULL,
    -- Sizing
    kelly_pct       NUMERIC,
    bet_size_usd    NUMERIC,
    -- Signals
    confidence      NUMERIC,
    grade           TEXT,                -- A+, A, B+, B, C
    sharp_direction TEXT,
    model_agreement NUMERIC,
    risk_flags      TEXT[],
    -- Resolution
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending, won, lost, push, void
    result_profit   NUMERIC DEFAULT 0,
    actual_score_home INTEGER,
    actual_score_away INTEGER,
    -- CLV
    closing_odds    NUMERIC,
    clv_cents       NUMERIC,
    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    -- Metadata
    metadata        JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_picks_status ON picks(status);
CREATE INDEX IF NOT EXISTS idx_picks_sport ON picks(sport);
CREATE INDEX IF NOT EXISTS idx_picks_event ON picks(event_id);
CREATE INDEX IF NOT EXISTS idx_picks_created ON picks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_picks_grade ON picks(grade);
CREATE INDEX IF NOT EXISTS idx_picks_market ON picks(market);

-- Line history (every odds observation)
CREATE TABLE IF NOT EXISTS line_history (
    id              BIGSERIAL PRIMARY KEY,
    event_id        TEXT NOT NULL,
    book            TEXT NOT NULL,
    sport           TEXT NOT NULL,
    market          TEXT NOT NULL,
    selection       TEXT NOT NULL,
    line            NUMERIC,
    odds_decimal    NUMERIC NOT NULL,
    odds_american   INTEGER NOT NULL,
    implied_prob    NUMERIC,
    observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lines_event ON line_history(event_id);
CREATE INDEX IF NOT EXISTS idx_lines_observed ON line_history(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_lines_book_event ON line_history(book, event_id);

-- Events (game metadata)
CREATE TABLE IF NOT EXISTS events (
    event_id        TEXT PRIMARY KEY,
    sport           TEXT NOT NULL,
    home_team       TEXT NOT NULL,
    away_team       TEXT NOT NULL,
    start_time      TIMESTAMPTZ,
    -- Pitcher info (MLB)
    home_pitcher    TEXT,
    away_pitcher    TEXT,
    -- Park
    venue           TEXT,
    park_factor     NUMERIC DEFAULT 1.0,
    -- Result
    status          TEXT DEFAULT 'scheduled',  -- scheduled, live, final
    home_score      INTEGER,
    away_score      INTEGER,
    first_inning_runs INTEGER,
    -- Metadata
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_sport ON events(sport);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_time);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- Daily performance snapshots
CREATE TABLE IF NOT EXISTS daily_stats (
    id              SERIAL PRIMARY KEY,
    stat_date       DATE NOT NULL UNIQUE,
    total_picks     INTEGER DEFAULT 0,
    won             INTEGER DEFAULT 0,
    lost            INTEGER DEFAULT 0,
    profit          NUMERIC DEFAULT 0,
    wagered         NUMERIC DEFAULT 0,
    roi_pct         NUMERIC DEFAULT 0,
    avg_ev          NUMERIC DEFAULT 0,
    avg_clv         NUMERIC DEFAULT 0,
    bankroll        NUMERIC DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_stats(stat_date DESC);

-- ML model training log
CREATE TABLE IF NOT EXISTS ml_training_log (
    id              SERIAL PRIMARY KEY,
    model_version   TEXT NOT NULL,
    trained_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    samples_used    INTEGER,
    val_logloss     NUMERIC,
    val_rmse        NUMERIC,
    feature_importance JSONB,
    metadata        JSONB DEFAULT '{}'
);

-- Team stats cache (refreshed daily from API)
CREATE TABLE IF NOT EXISTS team_stats (
    team_name       TEXT NOT NULL,
    sport           TEXT NOT NULL,
    season          INTEGER NOT NULL,
    -- Offense
    runs_per_game   NUMERIC,
    ops             NUMERIC,
    wrc_plus        NUMERIC,
    woba            NUMERIC,
    iso             NUMERIC,
    k_rate          NUMERIC,
    bb_rate         NUMERIC,
    -- Pitching
    team_era        NUMERIC,
    team_whip       NUMERIC,
    bullpen_era     NUMERIC,
    bullpen_whip    NUMERIC,
    -- Record
    wins            INTEGER,
    losses          INTEGER,
    win_pct         NUMERIC,
    win_pct_last10  NUMERIC,
    rpg_last10      NUMERIC,
    -- NRFI
    nrfi_pct        NUMERIC,
    -- Timestamps
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (team_name, sport, season)
);

-- Pitcher stats cache
CREATE TABLE IF NOT EXISTS pitcher_stats (
    pitcher_name    TEXT NOT NULL,
    team            TEXT NOT NULL,
    sport           TEXT NOT NULL DEFAULT 'mlb',
    season          INTEGER NOT NULL,
    -- Core stats
    era             NUMERIC,
    whip            NUMERIC,
    k_per_9         NUMERIC,
    bb_per_9        NUMERIC,
    hr_per_9        NUMERIC,
    fip             NUMERIC,
    ip_season       NUMERIC,
    -- Recent form
    era_last5       NUMERIC,
    whip_last5      NUMERIC,
    -- Handedness
    throws          TEXT,          -- L or R
    -- Timestamps
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (pitcher_name, team, season)
);

-- ══════════════════════════════════════════════
-- Functions
-- ══════════════════════════════════════════════

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER events_updated_at
    BEFORE UPDATE ON events
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════
-- Views
-- ══════════════════════════════════════════════

-- Current performance summary
CREATE OR REPLACE VIEW v_performance AS
SELECT
    sport,
    market,
    grade,
    COUNT(*) as total_picks,
    COUNT(*) FILTER (WHERE status = 'won') as won,
    COUNT(*) FILTER (WHERE status = 'lost') as lost,
    ROUND(COUNT(*) FILTER (WHERE status = 'won')::NUMERIC /
        NULLIF(COUNT(*) FILTER (WHERE status IN ('won','lost')), 0) * 100, 1) as win_rate,
    ROUND(SUM(result_profit)::NUMERIC, 2) as total_profit,
    ROUND(SUM(result_profit)::NUMERIC /
        NULLIF(SUM(bet_size_usd), 0) * 100, 1) as roi_pct,
    ROUND(AVG(ev_percent)::NUMERIC, 2) as avg_ev,
    ROUND(AVG(edge_percent)::NUMERIC, 2) as avg_edge,
    ROUND(AVG(clv_cents)::NUMERIC, 2) as avg_clv
FROM picks
WHERE status IN ('won', 'lost')
GROUP BY sport, market, grade
ORDER BY roi_pct DESC;

-- Recent picks view
CREATE OR REPLACE VIEW v_recent_picks AS
SELECT
    pick_id, created_at, sport,
    away_team || ' @ ' || home_team as game,
    market, selection, line,
    book, odds_american,
    ROUND(ev_percent::NUMERIC, 1) as ev_pct,
    ROUND(edge_percent::NUMERIC, 1) as edge_pct,
    grade, status,
    ROUND(result_profit::NUMERIC, 2) as profit,
    ROUND(clv_cents::NUMERIC, 1) as clv
FROM picks
ORDER BY created_at DESC
LIMIT 50;
