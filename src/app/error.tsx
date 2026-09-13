"use client";
import {PageError} from "@/components/social/shared";
export default function ErrorView({reset}:{error:Error;reset:()=>void}){return <PageError error="This view could not load. Retry, or return to Discover." retry={reset}/>;}
