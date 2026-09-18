import type { Metadata } from "next";
import { KakuAdmin } from "@/components/kaku-admin";
import { IndexVaultAdmin } from "@/components/index-vault-admin";
import { PrivateCycleAdmin } from "@/components/private-cycle-admin";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kaku San execution test",
  robots: { index: false, follow: false, nocache: true },
};

export default function KakuAdminPage() {
  return <>
    <KakuAdmin />
    <IndexVaultAdmin />
    <PrivateCycleAdmin />
  </>;
}
