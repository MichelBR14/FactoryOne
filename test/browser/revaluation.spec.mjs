import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", route => {
    const u = new URL(route.request().url());
    if (!["localhost","127.0.0.1"].includes(u.hostname) || u.pathname.startsWith("/b1s/")) return route.abort("blockedbyclient");
    return route.continue();
  });
});
async function openDemo(page) {
  await page.goto("/index.html?mode=development#/ggf/fechamento");
  await page.getByRole("button",{name:"Apurar e calcular"}).click();
  await page.getByRole("button",{name:"Avançar"}).click();
  await page.getByRole("button",{name:"Avançar"}).click();
  await page.getByRole("button",{name:"Prévia de reavaliação",exact:true}).click();
  await expect(page.locator('[id$="revaluationRows"]').getByText("DEV-PROD-A")).toBeVisible();
}
for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
  test(`simulation to revaluation preview ${viewport.width}`,async({page},info)=>{
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.setViewportSize(viewport);await openDemo(page);
    await expect(page.getByRole("button",{name:"Criar reavaliação"})).toBeDisabled();
    await expect(page.getByText("Prévia de custo calculada",{exact:true})).toHaveCount(3);
    await expect(page.getByText("Pronto para reavaliação",{exact:true})).toHaveCount(0);
    await expect(page.getByText("QUANTIDADE ELEGÍVEL NÃO COMPROVADA",{exact:true})).toHaveCount(3);
    await expect(page.getByText("4.000,00",{exact:true}).first()).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`revaluation-${viewport.width}.png`),fullPage:true});
    await page.locator('[id$="revaluationRows"]').getByText("DEV-PROD-A").click();
    await expect(page.getByText("Memória da OP 101",{exact:true})).toBeVisible();
    await expect(page.getByText("DEV-RECEIPT-101 / 0",{exact:true})).toBeVisible();
    await expect(page.getByText("7.000,00",{exact:true})).toBeVisible();
    await page.getByText("Memória da OP 101",{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:info.outputPath(`revaluation-detail-${viewport.width}.png`),fullPage:true});
    if(viewport.width===1440){
      const download=page.waitForEvent("download");await page.getByRole("button",{name:"Memória JSON",exact:true}).click();
      const memory=await download;
      expect(memory.suggestedFilename()).toBe("GGF-REVALUATION-development.json");
      const exported=JSON.parse(await readFile(await memory.path(),"utf8"));
      expect(exported.payload).toBeNull();expect(exported.payloadReady).toBe(false);
      expect(exported.documentSimulation.payload).toBeNull();expect(exported.postingBlocked).toBe(true);
      expect(exported.documentSimulation.rows.every(r=>r.status!=="APTO")).toBe(true);
      const csv=page.waitForEvent("download");await page.getByRole("button",{name:"Exportar prévia CSV",exact:true}).click();
      expect((await csv).suggestedFilename()).toBe("GGF-REVALUATION-development.csv");
    }
    await page.getByRole("button",{name:"Voltar ao fechamento",exact:true}).click();
    await expect(page.getByRole("button",{name:"Avançar"})).toBeDisabled();
    await page.goto("/index.html?mode=development#/ggf/reavaliacao");
    await expect(page.getByText(/Nenhuma simulação local disponível/)).toBeVisible();
    expect(errors).toEqual([]);
  });
}
test("SAP preview has no demonstration fallback and discards obsolete errors and busy",async({page})=>{
  await page.route("**/__ggf/revaluation",route=>route.fulfill({status:502,contentType:"application/json",body:"{}"}));
  await page.goto("/index.html?mode=development&source=sap-read#/ggf/reavaliacao");
  await expect(page.getByText(/Leitura SAP interrompida/)).toBeVisible();
  await expect(page.getByText("DEV-PROD-A")).toHaveCount(0);
  const id=await page.getByRole("button",{name:"Atualizar leitura SAP"}).getAttribute("id");
  const states=await page.evaluate(async id=>{
    let v=sap.ui.getCore().byId(id);while(v&&!v.getController)v=v.getParent();
    const c=v.getController(),m=v.getModel("preview"),queue=[],original=window.fetch;
    window.fetch=()=>new Promise((resolve,reject)=>queue.push({resolve,reject}));
    const state=()=>({busy:m.getProperty("/busy"),available:m.getProperty("/available"),error:m.getProperty("/error"),rows:m.getProperty("/rows")});
    try {
      const a=c.onLoad(),b=c.onLoad();queue.shift().reject(new Error("OLD"));await a;const old=state();
      queue.shift().resolve({ok:false});await b;const active=state();
      const d=c.onLoad();c.onLeaving({getParameter:()=>"ggf"});queue.shift().reject(new Error("LATE"));await d;const left=state();
      return {old,active,left};
    }finally{window.fetch=original;}
  },id);
  expect(states.old).toMatchObject({busy:true,available:false,error:"",rows:[]});
  expect(states.active).toMatchObject({busy:false,available:false,rows:[]});expect(states.active.error).toContain("Leitura SAP interrompida");
  expect(states.left).toMatchObject({busy:false,available:false,rows:[]});
});
test("production URL does not request SAP or invent a simulation",async({page})=>{
  let reads=0;page.on("request",r=>{if(r.url().includes("/__ggf/"))reads++;});
  await page.goto("/index.html#/ggf/reavaliacao");
  await expect(page.getByText(/Prévia indisponível neste ambiente/)).toBeVisible();
  await expect(page.getByRole("button",{name:"Criar reavaliação"})).toBeDisabled();expect(reads).toBe(0);
});
for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
  test(`technical FIFO trace is distinct from functional totals ${viewport.width}`,async({page},info)=>{
    await page.setViewportSize(viewport);
    const fifo={origin:"sap",technicalOnly:true,scenario:"F1FOP2609291",capturedAt:"2026-09-29T12:00:00Z",
      order:"83",item:"F1GGF26P01",itemName:"FactoryOne FIFO producao",warehouse:"01",unit:"UN",
      produced:"10.000000",originalLayerQuantity:"10",consumed:"6.000000",remaining:"4.000000",
      status:"FIFO_PARTIALLY_CONSUMED",receipt:{docEntry:122,docNum:77,line:0,date:"2026-09-29",quantity:10},
      layer:{label:"Camada do recebimento 77",openQty:4,cost:12},
      issues:[{docEntry:90,docNum:40,line:0,date:"2026-09-29",quantity:6}],
      example:{label:"Exemplo técnico, não é GGF funcional",ggfTotalMinor:"10000",ggfUnitMinor:"1000.000000",
        stockMinor:"4000",consumedMinor:"6000",stockStatus:"FIFO_STOCK_REVALUATION_CANDIDATE",
        consumedStatus:"FIFO_CONSUMED_GGF_PENDING_ACCOUNTING_RULE"},payload:null};
    await page.route("**/__ggf/revaluation",route=>route.fulfill({status:200,contentType:"application/json",
      body:JSON.stringify({origin:"sap",company:"SBODEMOBR2",postingBlocked:true,allocationId:"TECH-READ",
        allocationDate:"2026-09-29T12:00:00Z",stockDate:"2026-09-29T12:00:00Z",technicalOnly:true,
        rows:[],scopes:[],totalGgf:"0.00",estimatedTotal:null,payload:null,payloadReady:false,
        documentSimulation:{status:"MÉTODO NÃO HOMOLOGADO",rows:[],payload:null},fifoTechnicalTrace:fifo})}));
    await page.goto("/index.html?mode=development&source=sap-read#/ggf/reavaliacao");
    await expect(page.getByText("Rastreabilidade FIFO · cenário técnico")).toBeVisible();
    await expect(page.getByText("FIFO_PARTIALLY_CONSUMED",{exact:true})).toBeVisible();
    await expect(page.getByText("F1GGF26P01",{exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Criar reavaliação"})).toBeDisabled();
    await page.getByText("Memória FIFO da OP 83").click();
    await expect(page.getByText(/Saída 40 \/ linha 0/)).toBeVisible();
    await expect(page.getByText("FIFO_CONSUMED_GGF_PENDING_ACCOUNTING_RULE")).toBeVisible();
    await expect(page.getByText("Potencial sobre o estoque: R$ 40,00")).toBeVisible();
    await page.waitForTimeout(400);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`fifo-trace-${viewport.width}.png`),fullPage:true});
  });
}
