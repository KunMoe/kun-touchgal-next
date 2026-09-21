export const roundOneDecimal = (value: number | null | undefined) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0
  }
  return Math.round(value * 10) / 10
}
