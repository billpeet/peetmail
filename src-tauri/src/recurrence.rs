//! One model for how a series repeats, converted to and from Microsoft Graph's
//! `patternedRecurrence` and Google's RRULE (RFC 5545), so the UI shows and edits both
//! the same way.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum End {
    Never,
    /// Last date with an occurrence (inclusive), YYYY-MM-DD.
    Until { date: String },
    Count { count: u32 },
}

/// How a series repeats.
///
/// - Weekly: `days` (mon..sun).
/// - Monthly / yearly by date: `day_of_month` (and `month` for yearly).
/// - Monthly / yearly by weekday ("the second Tuesday"): `ordinal` (1..=4, or -1 for the
///   last) and one entry in `days` (and `month` for yearly).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recurrence {
    pub freq: Freq,
    pub interval: u32,
    #[serde(default)]
    pub days: Vec<String>,
    pub ordinal: Option<i32>,
    pub day_of_month: Option<u32>,
    /// 1..=12
    pub month: Option<u32>,
    pub end: End,
    /// First day of the series, YYYY-MM-DD.
    pub start: String,
}

const WEEKDAYS: [(&str, &str, &str); 7] = [
    ("mon", "monday", "MO"),
    ("tue", "tuesday", "TU"),
    ("wed", "wednesday", "WE"),
    ("thu", "thursday", "TH"),
    ("fri", "friday", "FR"),
    ("sat", "saturday", "SA"),
    ("sun", "sunday", "SU"),
];

fn day_from_graph(d: &str) -> Option<String> {
    WEEKDAYS.iter().find(|w| w.1 == d.to_ascii_lowercase()).map(|w| w.0.to_string())
}
#[cfg_attr(not(test), allow(dead_code))]
fn day_to_graph(d: &str) -> Option<&'static str> {
    WEEKDAYS.iter().find(|w| w.0 == d).map(|w| w.1)
}
fn day_from_rrule(d: &str) -> Option<String> {
    WEEKDAYS.iter().find(|w| w.2 == d.to_ascii_uppercase()).map(|w| w.0.to_string())
}
#[cfg_attr(not(test), allow(dead_code))]
fn day_to_rrule(d: &str) -> Option<&'static str> {
    WEEKDAYS.iter().find(|w| w.0 == d).map(|w| w.2)
}

const GRAPH_INDEX: [(&str, i32); 5] = [("first", 1), ("second", 2), ("third", 3), ("fourth", 4), ("last", -1)];

// ---------- Microsoft Graph ----------

/// From Graph's `recurrence` ({ pattern, range }).
pub fn from_graph(v: &Value) -> Option<Recurrence> {
    let p = &v["pattern"];
    let r = &v["range"];
    let kind = p["type"].as_str()?;
    let days: Vec<String> = p["daysOfWeek"].as_array().into_iter().flatten().filter_map(|d| d.as_str().and_then(day_from_graph)).collect();
    let ordinal = p["index"].as_str().and_then(|i| GRAPH_INDEX.iter().find(|g| g.0 == i).map(|g| g.1));
    let (freq, relative) = match kind {
        "daily" => (Freq::Daily, false),
        "weekly" => (Freq::Weekly, false),
        "absoluteMonthly" => (Freq::Monthly, false),
        "relativeMonthly" => (Freq::Monthly, true),
        "absoluteYearly" => (Freq::Yearly, false),
        "relativeYearly" => (Freq::Yearly, true),
        _ => return None,
    };
    let end = match r["type"].as_str() {
        Some("endDate") => End::Until { date: r["endDate"].as_str()?.to_string() },
        Some("numbered") => End::Count { count: r["numberOfOccurrences"].as_u64()? as u32 },
        _ => End::Never,
    };
    Some(Recurrence {
        freq,
        interval: p["interval"].as_u64().unwrap_or(1).max(1) as u32,
        days: if freq == Freq::Weekly || relative { days } else { vec![] },
        ordinal: if relative { ordinal.or(Some(1)) } else { None },
        day_of_month: (!relative && matches!(freq, Freq::Monthly | Freq::Yearly)).then(|| p["dayOfMonth"].as_u64().unwrap_or(1) as u32),
        month: (freq == Freq::Yearly).then(|| p["month"].as_u64().unwrap_or(1) as u32),
        end,
        start: r["startDate"].as_str().unwrap_or_default().to_string(),
    })
}

// Writing recurrence back (Graph and RRULE) waits for event editing; the tests use it already.
/// To Graph's `recurrence`. `time_zone` is the IANA/Windows zone the range dates are in.
#[cfg_attr(not(test), allow(dead_code))]
pub fn to_graph(r: &Recurrence, time_zone: &str) -> Value {
    let relative = r.ordinal.is_some();
    let kind = match (r.freq, relative) {
        (Freq::Daily, _) => "daily",
        (Freq::Weekly, _) => "weekly",
        (Freq::Monthly, false) => "absoluteMonthly",
        (Freq::Monthly, true) => "relativeMonthly",
        (Freq::Yearly, false) => "absoluteYearly",
        (Freq::Yearly, true) => "relativeYearly",
    };
    let mut pattern = json!({ "type": kind, "interval": r.interval.max(1) });
    if r.freq == Freq::Weekly || relative {
        pattern["daysOfWeek"] = json!(r.days.iter().filter_map(|d| day_to_graph(d)).collect::<Vec<_>>());
    }
    if r.freq == Freq::Weekly {
        pattern["firstDayOfWeek"] = json!("monday");
    }
    if let Some(o) = r.ordinal {
        pattern["index"] = json!(GRAPH_INDEX.iter().find(|g| g.1 == o).map(|g| g.0).unwrap_or("first"));
    }
    if let Some(d) = r.day_of_month.filter(|_| !relative) {
        pattern["dayOfMonth"] = json!(d);
    }
    if let Some(m) = r.month {
        pattern["month"] = json!(m);
    }
    let range = match &r.end {
        End::Never => json!({ "type": "noEnd", "startDate": r.start, "recurrenceTimeZone": time_zone }),
        End::Until { date } => json!({ "type": "endDate", "startDate": r.start, "endDate": date, "recurrenceTimeZone": time_zone }),
        End::Count { count } => json!({ "type": "numbered", "startDate": r.start, "numberOfOccurrences": count, "recurrenceTimeZone": time_zone }),
    };
    json!({ "pattern": pattern, "range": range })
}

// ---------- RFC 5545 RRULE (Google) ----------

/// From Google's `recurrence` lines (the first RRULE). `start` is the series' first day.
pub fn from_rrule(lines: &[String], start: &str) -> Option<Recurrence> {
    let rule = lines.iter().find_map(|l| l.strip_prefix("RRULE:"))?;
    let mut parts = std::collections::HashMap::new();
    for kv in rule.split(';') {
        if let Some((k, v)) = kv.split_once('=') {
            parts.insert(k.to_ascii_uppercase(), v.to_string());
        }
    }
    let freq = match parts.get("FREQ")?.to_ascii_uppercase().as_str() {
        "DAILY" => Freq::Daily,
        "WEEKLY" => Freq::Weekly,
        "MONTHLY" => Freq::Monthly,
        "YEARLY" => Freq::Yearly,
        _ => return None,
    };
    let mut days = Vec::new();
    let mut ordinal = None;
    for d in parts.get("BYDAY").map(|s| s.split(',').collect::<Vec<_>>()).unwrap_or_default() {
        // "TU", "2TU", "-1FR"
        let split = d.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(0);
        let (num, name) = d.split_at(split);
        if let Some(day) = day_from_rrule(name) {
            days.push(day);
        }
        if !num.is_empty() {
            ordinal = num.parse::<i32>().ok();
        }
    }
    if let Some(pos) = parts.get("BYSETPOS").and_then(|p| p.parse::<i32>().ok()) {
        ordinal = Some(pos);
    }
    let end = if let Some(u) = parts.get("UNTIL") {
        let digits: String = u.chars().take(8).collect();
        End::Until { date: format!("{}-{}-{}", &digits[0..4.min(digits.len())], digits.get(4..6).unwrap_or("01"), digits.get(6..8).unwrap_or("01")) }
    } else if let Some(c) = parts.get("COUNT").and_then(|c| c.parse().ok()) {
        End::Count { count: c }
    } else {
        End::Never
    };
    let relative = ordinal.is_some() && matches!(freq, Freq::Monthly | Freq::Yearly);
    let start_day: u32 = start.get(8..10).and_then(|d| d.parse().ok()).unwrap_or(1);
    let start_month: u32 = start.get(5..7).and_then(|d| d.parse().ok()).unwrap_or(1);
    Some(Recurrence {
        freq,
        interval: parts.get("INTERVAL").and_then(|i| i.parse().ok()).unwrap_or(1).max(1),
        days: if freq == Freq::Weekly && days.is_empty() {
            // Weekly without BYDAY repeats on the start's weekday.
            chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d")
                .ok()
                .map(|d| vec![WEEKDAYS[chrono::Datelike::weekday(&d).num_days_from_monday() as usize].0.to_string()])
                .unwrap_or_default()
        } else if freq == Freq::Weekly || relative {
            days
        } else {
            vec![]
        },
        ordinal: if relative { ordinal } else { None },
        day_of_month: (!relative && matches!(freq, Freq::Monthly | Freq::Yearly))
            .then(|| parts.get("BYMONTHDAY").and_then(|d| d.parse().ok()).unwrap_or(start_day)),
        month: (freq == Freq::Yearly).then(|| parts.get("BYMONTH").and_then(|m| m.parse().ok()).unwrap_or(start_month)),
        end,
        start: start.to_string(),
    })
}

/// To an RRULE line. Until dates are written as the end of that day in UTC, which keeps
/// the last occurrence for any time zone east of UTC-12.
#[cfg_attr(not(test), allow(dead_code))]
pub fn to_rrule(r: &Recurrence) -> String {
    let freq = match r.freq {
        Freq::Daily => "DAILY",
        Freq::Weekly => "WEEKLY",
        Freq::Monthly => "MONTHLY",
        Freq::Yearly => "YEARLY",
    };
    let mut parts = vec![format!("FREQ={freq}")];
    if r.interval > 1 {
        parts.push(format!("INTERVAL={}", r.interval));
    }
    match (r.freq, r.ordinal) {
        (Freq::Weekly, _) if !r.days.is_empty() => {
            parts.push(format!("BYDAY={}", r.days.iter().filter_map(|d| day_to_rrule(d)).collect::<Vec<_>>().join(",")));
        }
        (Freq::Monthly | Freq::Yearly, Some(o)) => {
            if let Some(d) = r.days.first().and_then(|d| day_to_rrule(d)) {
                parts.push(format!("BYDAY={o}{d}"));
            }
        }
        (Freq::Monthly | Freq::Yearly, None) => {
            if let Some(d) = r.day_of_month {
                parts.push(format!("BYMONTHDAY={d}"));
            }
        }
        _ => {}
    }
    if r.freq == Freq::Yearly
        && let Some(m) = r.month {
            parts.push(format!("BYMONTH={m}"));
        }
    match &r.end {
        End::Never => {}
        End::Until { date } => parts.push(format!("UNTIL={}T235959Z", date.replace('-', ""))),
        End::Count { count } => parts.push(format!("COUNT={count}")),
    }
    format!("RRULE:{}", parts.join(";"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn weekly() -> Recurrence {
        Recurrence {
            freq: Freq::Weekly,
            interval: 2,
            days: vec!["tue".into(), "thu".into()],
            ordinal: None,
            day_of_month: None,
            month: None,
            end: End::Until { date: "2026-12-03".into() },
            start: "2026-10-27".into(),
        }
    }

    #[test]
    fn graph_patterns_round_trip() {
        let g = json!({
            "pattern": { "type": "weekly", "interval": 2, "daysOfWeek": ["tuesday", "thursday"], "firstDayOfWeek": "monday" },
            "range": { "type": "endDate", "startDate": "2026-10-27", "endDate": "2026-12-03" }
        });
        let r = from_graph(&g).unwrap();
        assert_eq!(r, weekly());
        let back = to_graph(&r, "Australia/Sydney");
        assert_eq!(back["pattern"]["daysOfWeek"], json!(["tuesday", "thursday"]));
        assert_eq!(back["range"]["type"], "endDate");
        assert_eq!(from_graph(&back).unwrap(), r);

        let relative = json!({
            "pattern": { "type": "relativeMonthly", "interval": 1, "daysOfWeek": ["friday"], "index": "last" },
            "range": { "type": "numbered", "startDate": "2026-10-30", "numberOfOccurrences": 6 }
        });
        let r = from_graph(&relative).unwrap();
        assert_eq!((r.freq, r.ordinal, r.days.clone(), r.end.clone()), (Freq::Monthly, Some(-1), vec!["fri".to_string()], End::Count { count: 6 }));
        assert_eq!(to_graph(&r, "UTC")["pattern"]["index"], "last");

        let yearly = json!({
            "pattern": { "type": "absoluteYearly", "interval": 1, "dayOfMonth": 3, "month": 11 },
            "range": { "type": "noEnd", "startDate": "2026-11-03" }
        });
        let r = from_graph(&yearly).unwrap();
        assert_eq!((r.day_of_month, r.month, r.end.clone()), (Some(3), Some(11), End::Never));
        assert_eq!(from_graph(&to_graph(&r, "UTC")).unwrap(), r);
    }

    #[test]
    fn rrules_round_trip() {
        let r = from_rrule(&["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261203T235959Z".into()], "2026-10-27").unwrap();
        assert_eq!(r, weekly());
        assert_eq!(to_rrule(&r), "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261203T235959Z");

        let last_friday = from_rrule(&["RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=6".into()], "2026-10-30").unwrap();
        assert_eq!((last_friday.ordinal, last_friday.days.clone(), last_friday.end.clone()), (Some(-1), vec!["fri".to_string()], End::Count { count: 6 }));
        assert_eq!(to_rrule(&last_friday), "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=6");

        // Google often leaves out what the start date implies.
        let plain_weekly = from_rrule(&["RRULE:FREQ=WEEKLY".into()], "2026-10-27").unwrap();
        assert_eq!(plain_weekly.days, vec!["tue".to_string()]);
        let monthly = from_rrule(&["EXDATE:20261103".into(), "RRULE:FREQ=MONTHLY".into()], "2026-10-15").unwrap();
        assert_eq!((monthly.day_of_month, monthly.ordinal), (Some(15), None));
        let yearly = from_rrule(&["RRULE:FREQ=YEARLY".into()], "2026-11-03").unwrap();
        assert_eq!((yearly.month, yearly.day_of_month), (Some(11), Some(3)));
        assert_eq!(from_rrule(&["RRULE:FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=3".into()], "2026-11-03").unwrap(), yearly);
        assert!(from_rrule(&["RDATE:20261101".into()], "2026-10-01").is_none());
    }

    #[test]
    fn graph_and_google_meet_in_the_middle() {
        // The same series described by each service comes out the same.
        let g = from_graph(&json!({
            "pattern": { "type": "relativeYearly", "interval": 1, "daysOfWeek": ["monday"], "index": "first", "month": 9 },
            "range": { "type": "noEnd", "startDate": "2026-09-07" }
        }))
        .unwrap();
        let r = from_rrule(&["RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=1MO".into()], "2026-09-07").unwrap();
        assert_eq!(g, r);
        assert_eq!(to_rrule(&g), "RRULE:FREQ=YEARLY;BYDAY=1MO;BYMONTH=9");
    }
}
