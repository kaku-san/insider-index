import { ConsumerIndex } from "@/components/consumer-index";
export default async function IndexPage({params}:{params:Promise<{id:string}>}){ const {id}=await params; return <ConsumerIndex id={id}/>; }
