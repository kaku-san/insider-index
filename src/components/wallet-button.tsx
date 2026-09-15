"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { Icon } from "@/components/social/icon";
import { shortenAddress } from "@/lib/format";
import { WalletConnectSheet } from "./wallet-connect-sheet";
export function WalletButton(){const wallet=usePrivySolana(),[open,setOpen]=useState(false);return <><Button className="button primary wallet-button" onClick={()=>setOpen(true)}><Icon name="wallet" size={17}/><span>{wallet.authenticated&&wallet.solanaAddress?shortenAddress(wallet.solanaAddress):"Connect"}</span></Button><WalletConnectSheet open={open} onClose={()=>setOpen(false)}/></>}
