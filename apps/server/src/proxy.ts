import { BlockList, isIP } from "node:net";

// Render forwards through its internal proxy and Cloudflare. Walk at most
// those two trusted hops; never consume a visitor-supplied X-Forwarded-For prefix.
// Cloudflare's authoritative ranges, checked 2026-10-10:
// https://www.cloudflare.com/ips/
const cloudflare = new BlockList();
for (const cidr of [
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "108.162.192.0/18",
  "131.0.72.0/22",
  "141.101.64.0/18",
  "162.158.0.0/15",
  "172.64.0.0/13",
  "173.245.48.0/20",
  "188.114.96.0/20",
  "190.93.240.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
]) {
  const [address, prefix] = cidr.split("/");
  cloudflare.addSubnet(
    address,
    Number(prefix),
    isIP(address) === 6 ? "ipv6" : "ipv4",
  );
}
const internal = new BlockList();
for (const cidr of [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "::1/128",
  "fc00::/7",
]) {
  const [address, prefix] = cidr.split("/");
  internal.addSubnet(
    address,
    Number(prefix),
    isIP(address) === 6 ? "ipv6" : "ipv4",
  );
}

export function trustProxy(address: string, hop: number): boolean {
  const version = isIP(address);
  if (!version || hop < 0 || hop > 1) return false;
  const family = version === 6 ? "ipv6" : "ipv4";
  return hop === 0
    ? internal.check(address, family)
    : cloudflare.check(address, family);
}
