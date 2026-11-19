/** True when the deployment runs in private-test mode (sends restricted to approved testers). */
export function privateTestMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.PRIVATE_TEST?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on";
}
