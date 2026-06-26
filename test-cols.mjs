import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";

const envStr = fs.readFileSync(".env", "utf-8");
let supabaseUrl = "";
let supabaseKey = "";

envStr.split("\n").forEach(line => {
  if (line.startsWith("NEXT_PUBLIC_SUPABASE_URL=")) {
    supabaseUrl = line.split("=")[1].replace(/"/g, "").trim();
  }
  if (line.startsWith("SUPABASE_SERVICE_ROLE_KEY=")) {
    supabaseKey = line.split("=")[1].replace(/"/g, "").trim();
  }
});

const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data, error } = await supabaseAdmin.from('tenants').select('*').limit(1);
  console.log("data:", data);
  console.log("error:", error);
}

run();
