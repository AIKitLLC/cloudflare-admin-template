const JOB_NAME = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/

export function isWellFormedJobName(name: string): boolean {
  return name.length <= 80 && JOB_NAME.test(name)
}
