export function useSearchParams() {
  return new URLSearchParams();
}
export function usePathname() {
  return "/";
}
export function useRouter() {
  return { push() {}, replace() {}, prefetch() {}, back() {} };
}
