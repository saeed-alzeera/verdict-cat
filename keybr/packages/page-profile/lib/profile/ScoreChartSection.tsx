import { Marker, ScoreChart } from "@keybr/chart";
import { hasData } from "@keybr/math";
import { type Result } from "@keybr/result";
import { Explainer, Figure } from "@keybr/widget";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { ChartWrapper } from "./ChartWrapper.tsx";
import { SmoothnessRange } from "./SmoothnessRange.tsx";

export function ScoreChartSection({ results }: { results: readonly Result[] }) {
  const [smoothness, setSmoothness] = useState(0.5);

  return (
    <Figure>
      <Figure.Caption>
        <FormattedMessage
          id="profile.chart.score.caption"
          defaultMessage="Score History"
        />
      </Figure.Caption>

      <Explainer>
        <Figure.Description>
          <FormattedMessage
            id="profile.chart.score.description"
            defaultMessage="This chart shows how overall score changes over time."
          />
        </Figure.Description>
      </Explainer>

      <ChartWrapper>
        <ScoreChart
          results={results}
          smoothness={smoothness}
          width="100%"
          height="25rem"
        />
      </ChartWrapper>

      <SmoothnessRange
        disabled={!hasData(results)}
        value={smoothness}
        onChange={setSmoothness}
      />

      <Figure.Legend>
        <FormattedMessage
          id="profile.chart.score.legend"
          defaultMessage="Horizontal axis: lesson number. Vertical axis: {label1} – score."
          values={{
            label1: <Marker type="threshold" />,
          }}
        />
      </Figure.Legend>
    </Figure>
  );
}
