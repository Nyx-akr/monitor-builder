/**
 * The chart module: everything about drawing charts lives here, so blocks (the Chart object, Page widgets)
 * only pass lines and settings in.
 *
 *   types.ts      Point, Series, Candle, ChartStyle
 *   options.ts    colours, timeframes, styles, candle sizes, axis formatting
 *   data.ts       turning what arrives (history, token lists, numbers) into lines; candles
 *   ChartView.tsx the chart itself: guide, plot (line / area / candles), axes
 */
export * from './types'
export * from './options'
export * from './data'
export { ChartView, type ChartLine, type ChartViewProps } from './ChartView'
