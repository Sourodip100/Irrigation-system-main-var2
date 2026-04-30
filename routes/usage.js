// routes/usage.js
//
// ─── HOW TO REGISTER IN server.js ────────────────────────────────────────────
//
// Step 1 — add import at the top of server.js:
//   import usageRoutes from "./routes/usage.js";
//
// Step 2 — add the route BEFORE  app.use("/api", apiRoutes)  :
//   app.use("/api/usage", usageRoutes);
//
// The order matters — if it comes AFTER  app.use("/api", apiRoutes)
// the SPA fallback will swallow the request and return index.html,
// which is why you see  "Unexpected token '<'"  in the console.
//
// Final order should look like:
//   app.use("/api/auth",  authRoutes);
//   app.use("/api/usage", usageRoutes);   ← add this line
//   app.use("/api",       apiRoutes);     ← this stays last
//
// ─────────────────────────────────────────────────────────────────────────────

import express       from "express";
import mongoose      from "mongoose";
import Field         from "../models/Field.js";
import Crop          from "../models/Crop.js";
import IrrigationLog from "../models/IrrigationLog.js";
import { protect }   from "../middleware/auth.js";

const router = express.Router();

router.use(protect);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/usage/crop?cropId=<mongoId>&days=30
// ─────────────────────────────────────────────────────────────────────────────
router.get("/crop", async (req, res) => {
  try {
    const { cropId, days: daysParam } = req.query;
    const days   = parseInt(daysParam) || 30;
    const userId = req.user.id;

    // ── Validate cropId ───────────────────────────────────────────────────
    if (!cropId || !mongoose.Types.ObjectId.isValid(cropId)) {
      return res.status(400).json({ success: false, message: "Invalid or missing cropId." });
    }

    // ── Load crop ─────────────────────────────────────────────────────────
    const crop = await Crop.findById(cropId);
    if (!crop) {
      return res.status(404).json({ success: false, message: "Crop not found." });
    }

    const st          = crop.stages;
    const total_cycle = st.initial.days + st.growth.days + st.mid.days + st.late.days;

    // ── Get this farmer's fields for this crop ────────────────────────────
    const fields     = await Field.find({ userId, cropId: crop._id });
    const field_ids  = fields.map(f => f._id);
    const total_area = fields.reduce((sum, f) => sum + (f.area || 0), 0);

    // Planting date — use first field, or today as fallback
    const plantingDate = fields.length > 0
      ? new Date(Math.min(...fields.map(f => new Date(f.plantingDate || f._id.getTimestamp()))))
      : new Date();

    const days_since_planting = Math.max(0,
      Math.floor((new Date() - plantingDate) / (1000 * 60 * 60 * 24))
    );

    // ── Current lifecycle stage ───────────────────────────────────────────
    let current_stage     = "Harvest Ready";
    let current_water_sqm = 0;

    if (days_since_planting <= st.initial.days) {
      current_stage     = "Initial Stage";
      current_water_sqm = st.initial.water;
    } else if (days_since_planting <= st.initial.days + st.growth.days) {
      current_stage     = "Growth Stage";
      current_water_sqm = st.growth.water;
    } else if (days_since_planting <= st.initial.days + st.growth.days + st.mid.days) {
      current_stage     = "Mid Stage";
      current_water_sqm = st.mid.water;
    } else if (days_since_planting <= total_cycle) {
      current_stage     = "Late Stage";
      current_water_sqm = st.late.water;
    }

    // optimal_today = water per sqm × total area across all farmer's fields for this crop
    // If farmer has no fields yet, use 1 sqm as placeholder
    const optimal_today = current_water_sqm * (total_area || 1);

    // ── Date range ────────────────────────────────────────────────────────
    const now       = new Date();
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);
    sinceDate.setHours(0, 0, 0, 0);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const todayStr   = now.toISOString().slice(0, 10);
    const monthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // ── Fetch logs — IrrigationLog.date is a Date object ─────────────────
    // Only query if the farmer actually has fields with this crop
    let allLogs = [];
    if (field_ids.length > 0) {
      allLogs = await IrrigationLog.find({
        fieldId: { $in: field_ids },
        date:    { $gte: sinceDate, $lte: now }
      }).sort({ date: 1 });
    }

    // ── Build daily series ────────────────────────────────────────────────
    const dailyActualMap  = {};
    const dailyOptimalMap = {};

    allLogs.forEach(log => {
      const ds = new Date(log.date).toISOString().slice(0, 10);
      dailyActualMap[ds]  = (dailyActualMap[ds]  || 0) + log.amountApplied;
      dailyOptimalMap[ds] = (dailyOptimalMap[ds] || 0) + log.optimalAmount;
    });

    const daily_series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d  = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      daily_series.push({
        date:    ds,
        actual:  dailyActualMap[ds]  || 0,
        optimal: dailyOptimalMap[ds] || optimal_today
      });
    }

    // ── Today's sessions ──────────────────────────────────────────────────
    let todayLogs = [];
    if (field_ids.length > 0) {
      todayLogs = await IrrigationLog.find({
        fieldId: { $in: field_ids },
        date:    { $gte: todayStart, $lte: todayEnd }
      }).sort({ date: 1 });
    }

    const sessions = todayLogs.map(log => ({
      litres_used:  log.amountApplied,
      optimal:      log.optimalAmount,
      notes:        "Field irrigation",
      duration_min: null,
      logged_at:    log.date
    }));

    const today_total = sessions.reduce((s, l) => s + l.litres_used, 0);

    // ── Monthly totals ────────────────────────────────────────────────────
    let monthLogs = [];
    if (field_ids.length > 0) {
      monthLogs = await IrrigationLog.find({
        fieldId: { $in: field_ids },
        date:    { $gte: monthStart, $lte: now }
      });
    }

    const month_used       = monthLogs.reduce((s, l) => s + l.amountApplied, 0);
    const allocated_litres = optimal_today * 30;
    const remaining        = Math.max(0, allocated_litres - month_used);
    const percent_used     = allocated_litres > 0
      ? Math.min(100, Math.round((month_used / allocated_litres) * 100))
      : 0;

    // ── Platform average (all farmers, same crop) ─────────────────────────
    // Get ALL fields with this crop (across all users)
    const allCropFields   = await Field.find({ cropId: crop._id }).select("_id");
    const allCropFieldIds = allCropFields.map(f => f._id);

    let platform_raw = [];
    if (allCropFieldIds.length > 0) {
      platform_raw = await IrrigationLog.aggregate([
        {
          $match: {
            fieldId: { $in: allCropFieldIds },
            date:    { $gte: sinceDate, $lte: now }
          }
        },
        // Step 1: group by field + day to get each field's daily total
        {
          $group: {
            _id: {
              fieldId: "$fieldId",
              day:     { $dateToString: { format: "%Y-%m-%d", date: "$date" } }
            },
            day_total: { $sum: "$amountApplied" }
          }
        },
        // Step 2: average those totals per day across all fields
        {
          $group: {
            _id: "$_id.day",
            avg: { $avg: "$day_total" }
          }
        },
        { $sort: { _id: 1 } }
      ]);
    }

    const platformMap = {};
    platform_raw.forEach(p => { platformMap[p._id] = Math.round(p.avg); });

    const platform_series = daily_series.map(d => ({
      date: d.date,
      avg:  platformMap[d.date] || null
    }));

    // ── Summary stats ─────────────────────────────────────────────────────
    const active_days  = daily_series.filter(d => d.actual > 0).length;
    const total_used   = daily_series.reduce((s, d) => s + d.actual,  0);
    const total_opt    = daily_series.reduce((s, d) => s + d.optimal, 0);
    const avg_daily    = active_days > 0 ? Math.round(total_used / active_days) : 0;
    const avg_optimal  = active_days > 0 ? Math.round(total_opt  / active_days) : optimal_today;

    const optimal_days = daily_series.filter(d =>
      d.actual > 0 &&
      d.actual >= d.optimal * 0.8 &&
      d.actual <= d.optimal * 1.2
    ).length;
    const over_days  = daily_series.filter(d => d.actual > d.optimal * 1.2).length;
    const under_days = daily_series.filter(d => d.actual > 0 && d.actual < d.optimal * 0.8).length;

    const efficiency = total_opt > 0
      ? Math.max(0, Math.min(100,
          Math.round(100 - (Math.abs(total_used - total_opt) / total_opt) * 100)
        ))
      : 0;

    // ── Weekly buckets ────────────────────────────────────────────────────
    const weekMap = {};
    daily_series.forEach(d => {
      const wk = `W${isoWeek(new Date(d.date))}`;
      if (!weekMap[wk]) weekMap[wk] = { label: wk, actual_total: 0, optimal_total: 0, dates: [] };
      weekMap[wk].actual_total  += d.actual;
      weekMap[wk].optimal_total += d.optimal;
      weekMap[wk].dates.push(d.date);
    });

    // ── Response ──────────────────────────────────────────────────────────
    res.json({
      success: true,

      crop: {
        _id:              crop._id,
        name:             crop.name,
        minMoisture:      crop.minMoisture,
        maxMoisture:      crop.maxMoisture,
        temperatureRange: crop.temperatureRange,
        stages:           crop.stages,
        total_cycle_days: total_cycle
      },

      allocation: {
        month:            monthLabel,
        allocated_litres,
        month_used,
        remaining,
        percent_used
      },

      today: {
        date:               todayStr,
        total:              today_total,
        sessions,
        optimal_today,
        days_since_planting,
        current_stage,
        is_over:    today_total > optimal_today * 1.2,
        is_under:   today_total > 0 && today_total < optimal_today * 0.8,
        is_optimal: today_total >= optimal_today * 0.8 && today_total <= optimal_today * 1.2
      },

      chart_data: {
        days,
        daily_series,
        platform_series
      },

      weekly: Object.values(weekMap),

      summary: {
        total_used,
        active_days,
        avg_daily,
        avg_optimal,
        optimal_days,
        over_days,
        under_days,
        efficiency
      }
    });

  } catch (err) {
    console.error("[usage route] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ISO week number helper
function isoWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / 86400000 - 3 + (w1.getDay() + 6) % 7) / 7);
}

export default router;
