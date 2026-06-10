import { useIntlNumbers } from "@keybr/intl";
import { hasData, linearRegression, Range, smooth, Vector } from "@keybr/math";
import { type Result } from "@keybr/result";
import { Canvas, type Rect, type ShapeList } from "@keybr/widget";
import { type ReactNode } from "react";
import { useIntl } from "react-intl";
import { Chart, chartArea, type SizeProps } from "./Chart.tsx";
import { withStyles } from "./decoration.ts";
import { paintCurve, paintScatterPlot, projection } from "./graph.ts";
import { type ChartStyles, useChartStyles } from "./use-chart-styles.ts";

export function ScoreChart({
  results,
  smoothness,
  width,
  height,
}: {
  readonly results: readonly Result[];
  readonly smoothness: number;
} & SizeProps): ReactNode {
  const styles = useChartStyles();
  const paint = usePaint(styles, results, smoothness);
  return (
    <Chart width={width} height={height}>
      <Canvas paint={chartArea(styles, paint)} />
    </Chart>
  );
}

function usePaint(
  styles: ChartStyles,
  results: readonly Result[],
  smoothness: number,
) {
  const { formatMessage } = useIntl();
  const { formatInteger } = useIntlNumbers();
  const g = withStyles(styles);

  if (!hasData(results)) {
    return (box: Rect): ShapeList => {
      return [
        g.paintGrid(box, "horizontal", { lines: 5 }),
        g.paintGrid(box, "vertical", { lines: 5 }),
        g.paintAxis(box, "bottom"),
        g.paintAxis(box, "left"),
        g.paintNoData(box, formatMessage),
      ];
    };
  }

  const vIndex = new Vector();
  const vScore = new Vector();
  const sScore = smooth(smoothness);
  for (let index = 0; index < results.length; index++) {
    vIndex.add(index + 1);
    vScore.add(sScore(results[index].score));
  }
  const rIndex = Range.from(vIndex);
  const rScore = Range.from(vScore).round(100);

  const mScore = linearRegression(vIndex, vScore);

  return (box: Rect): ShapeList => {
    const projScore = projection(box, rIndex, rScore);
    return [
      g.paintGrid(box, "horizontal", { lines: 5 }),
      g.paintGrid(box, "vertical", { lines: 5 }),
      g.paintAxis(box, "bottom"),
      g.paintAxis(box, "left"),
      paintScatterPlot(projScore, vIndex, vScore, {
        style: styles.threshold,
      }),
      paintCurve(projScore, mScore, {
        style: {
          ...styles.threshold,
          lineWidth: 2,
        },
      }),
      g.paintTicks(box, rIndex, "bottom", { lines: 5, fmt: formatInteger }),
      g.paintTicks(box, rScore, "left", { fmt: formatInteger }),
    ];
  };
}
