import { redirect } from "next/navigation";

/** Native intent IDs are not saved operations. Keep old links in product navigation instead of
 * attempting a missing API read and rendering an implementation error. */
export default function OperationPage() {
  redirect("/positions");
}
