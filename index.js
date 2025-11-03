import sql from "mssql";
import OpenAI from "openai";

// OpenAI client (npm openai package)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: `${process.env.OPENAI_ENDPOINT}/openai/deployments/${process.env.OPENAI_DEPLOYMENT_ID}`,
  defaultQuery: { "api-version": process.env.OPENAI_API_VERSION },
});

export default async function (context, req) {
  const { programId, tripId } = req.body;

  const config = {
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    server: process.env.SQL_SERVER,
    database: process.env.TRIP_DB,
    options: { encrypt: true, trustServerCertificate: false },
  };

  try {
    await sql.connect(config);

    // Step 1: Get all excursions for this trip
    const excursionsResult = await sql.query`
      SELECT te.ExcursionId, te.AlarmTypeId, te.LocationAddress, te.ExcursionName
      FROM ${process.env.TRIP_DB}.dbo.TripExcursion te
      JOIN ${process.env.TRIP_DB}.dbo.Shipment s ON s.Id = te.TripId
      WHERE s.ProgramId = ${programId}
        AND te.TripId = ${tripId}
        AND te.Disabled = 0
    `;

    const excursions = excursionsResult.recordset;

    const enrichedExcursions = [];

    // Step 2: For each excursion, find most common historical reason
    for (const exc of excursions) {
      const histResult = await sql.query`
        SELECT TOP 1 te.EventReasons, COUNT(*) AS MatchCount
        FROM ${process.env.TRIP_DB}.dbo.TripExcursion te
        JOIN ${process.env.TRIP_DB}.dbo.Shipment s ON s.Id = te.TripId
        WHERE s.ProgramId = ${programId}
          AND te.LocationAddress = ${exc.LocationAddress}
          AND te.AlarmTypeId = ${exc.AlarmTypeId}
          AND te.EventReasons IS NOT NULL
          AND te.EventReasons <> ''
          AND te.Disabled = 0
        GROUP BY te.EventReasons
        ORDER BY MatchCount DESC
      `;

      let reasonId = null;
      let reasonName = null;
      let comment = null;
      let confidence = "Low";

      if (histResult.recordset.length > 0) {
        reasonId = histResult.recordset[0].EventReasons;
        const count = histResult.recordset[0].MatchCount;

        // Lookup reason name from Rules DB
        const reasonLookup = await sql.query`
          SELECT Name 
          FROM ${process.env.RULES_DB}.dbo.AcknowledgementReasonDefinition
          WHERE AcknowledgementReasonDefinitionId = ${reasonId}
            AND ProgramId = ${programId}
            AND Enabled = 1
        `;

        reasonName = reasonLookup.recordset[0]?.Name || "Unknown Reason";

        // Generate AI comment
        const prompt = `Generate a short QA comment for alarm '${exc.ExcursionName}' at location '${exc.LocationAddress}'. 
        Historical data shows ${count} past alarms at this location with reason: '${reasonName}'. 
        Write a professional comment that explains this is a recurring pattern.`;

        const response = await openai.completions.create({
          model: process.env.OPENAI_DEPLOYMENT_ID,
          prompt,
          max_tokens: 100,
        });

        comment = response.choices[0].text.trim();
        confidence = "High";
      }

      enrichedExcursions.push({
        excursionId: exc.ExcursionId,
        alarmTypeId: exc.AlarmTypeId,
        locationAddress: exc.LocationAddress,
        excursionName: exc.ExcursionName,
        suggestedReasonId: reasonId,
        suggestedReasonName: reasonName,
        comment,
        confidence,
      });
    }

    // Step 3: Return all excursions enriched
    context.res = {
      body: {
        tripId,
        programId,
        excursions: enrichedExcursions,
      },
    };
  } catch (err) {
    context.log.error("Error:", err);
    context.res = {
      status: 500,
      body: {
        message: "Error processing request",
        error: err.message,
        stack: err.stack,
      },
    };
  }
}
