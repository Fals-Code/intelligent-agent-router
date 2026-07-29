import type { Complexity, Modality, RiskLevel, TaskAnalysis } from "../domain/types.js";

const patterns = {
  fresh: /\b(latest|terbaru|hari ini|sekarang|current|update|harga|jadwal|cuaca|berita|news)\b/i,
  code: /\b(code|kode|repo|repository|github|pull request|commit|branch|bug|typescript|javascript|python|api|database|sql|ci|test)\b/i,
  security: /\b(security|keamanan|vulnerability|kerentanan|exploit|auth|rls|injection|secret)\b/i,
  image: /\b(gambar|image|foto|logo|poster|edit image|desain visual)\b/i,
  document: /\b(docx|dokumen|proposal|laporan|memo|surat|essay|makalah|pdf)\b/i,
  spreadsheet: /\b(excel|spreadsheet|xlsx|csv|rumus|formula|dashboard data)\b/i,
  research: /\b(research|riset|analisis mendalam|deep research|literature|jurnal|sumber|citation|sitasi)\b/i,
  writeAction: /\b(create|buat|ubah|edit|hapus|delete|merge|push|commit|kirim|send|publish|deploy)\b/i,
  destructive: /\b(hapus|delete|drop|force push|overwrite|merge|publish|kirim|transfer)\b/i,
  highStake: /\b(medis|medical|legal|hukum|investasi|financial advice|keuangan pribadi|security|cyber)\b/i,
};

export class HeuristicAnalyzer {
  analyze(prompt: string): TaskAnalysis {
    const normalizedPrompt = prompt.trim().replace(/\s+/g, " ");
    const modalities: Modality[] = ["text"];
    const capabilities = new Set<string>(["classification", "structured-output"]);
    const preferred = new Set<string>();
    const requiredSkills = new Set<string>();

    let domain = "general";
    let complexity: Complexity = normalizedPrompt.length > 800 ? "complex" : normalizedPrompt.length > 250 ? "moderate" : "simple";
    let risk: RiskLevel = "low";

    if (patterns.code.test(normalizedPrompt)) {
      domain = "software";
      modalities.push("code");
      capabilities.add("coding");
      capabilities.add("planning");
    }
    if (patterns.security.test(normalizedPrompt)) {
      domain = "security";
      complexity = "expert";
      risk = "high";
      capabilities.add("security-analysis");
      capabilities.add("deep-reasoning");
    }
    if (patterns.image.test(normalizedPrompt)) {
      modalities.push("image");
      requiredSkills.add("image-generation");
      capabilities.add("vision");
      complexity = complexity === "simple" ? "moderate" : complexity;
    }
    if (patterns.document.test(normalizedPrompt)) {
      modalities.push("file");
      requiredSkills.add("document-builder");
      capabilities.add("document-analysis");
      complexity = complexity === "simple" ? "moderate" : complexity;
    }
    if (patterns.spreadsheet.test(normalizedPrompt)) {
      modalities.push("file");
      requiredSkills.add("spreadsheet-builder");
      capabilities.add("data-analysis");
      complexity = complexity === "simple" ? "moderate" : complexity;
    }
    if (patterns.fresh.test(normalizedPrompt)) {
      requiredSkills.add("web-search");
      capabilities.add("research");
      capabilities.add("tool-use");
    }
    if (patterns.research.test(normalizedPrompt)) {
      preferred.add("research");
      preferred.add("document-analysis");
      complexity = complexity === "simple" ? "moderate" : complexity;
    }
    if (/\bgithub\b/i.test(normalizedPrompt)) {
      requiredSkills.add("github");
      capabilities.add("tool-use");
    }
    if (patterns.highStake.test(normalizedPrompt)) {
      risk = risk === "high" ? "high" : "medium";
      preferred.add("deep-reasoning");
    }
    if (patterns.destructive.test(normalizedPrompt)) risk = "high";

    const requiresExternalAction = patterns.writeAction.test(normalizedPrompt);
    const requiresVerification =
      complexity === "complex" ||
      complexity === "expert" ||
      risk === "high" ||
      requiredSkills.size > 1 ||
      patterns.fresh.test(normalizedPrompt);

    if (requiresExternalAction && risk === "high") requiredSkills.add("human-approval");

    const intent = this.inferIntent(normalizedPrompt);
    const outputFormat = this.inferOutputFormat(normalizedPrompt);
    const uniqueModalities = [...new Set(modalities)];

    return {
      rawPrompt: prompt,
      normalizedPrompt,
      intent,
      domain,
      complexity,
      risk,
      modalities: uniqueModalities,
      requiredCapabilities: [...capabilities],
      preferredCapabilities: [...preferred],
      requiredSkills: [...requiredSkills],
      outputFormat,
      requiresFreshData: patterns.fresh.test(normalizedPrompt),
      requiresExternalAction,
      requiresVerification,
      canParallelize: complexity === "complex" || complexity === "expert",
      estimatedContextTokens: Math.max(512, Math.ceil(normalizedPrompt.length / 3.5)),
      confidence: 0.66,
      ambiguities: [],
      constraints: {
        maxCostTier: complexity === "simple" ? 1 : complexity === "moderate" ? 2 : 4,
        maxLatencyTier: complexity === "simple" ? 2 : 4,
        privacy: "internal",
        requireHumanApprovalForWrites: risk === "high",
      },
    };
  }

  private inferIntent(prompt: string): string {
    if (/\b(review|audit|cek|periksa)\b/i.test(prompt)) return "review";
    if (/\b(create|buat|bangun|implement|develop)\b/i.test(prompt)) return "create";
    if (/\b(edit|ubah|revisi|perbaiki|fix)\b/i.test(prompt)) return "modify";
    if (/\b(search|cari|research|riset)\b/i.test(prompt)) return "research";
    if (/\b(explain|jelaskan|apa itu|bagaimana)\b/i.test(prompt)) return "explain";
    return "answer";
  }

  private inferOutputFormat(prompt: string): string {
    if (/\bjson\b/i.test(prompt)) return "json";
    if (/\b(code|kode|implementasi)\b/i.test(prompt)) return "code";
    if (/\b(docx|dokumen|proposal|laporan|memo)\b/i.test(prompt)) return "document";
    if (/\b(xlsx|excel|spreadsheet|csv)\b/i.test(prompt)) return "spreadsheet";
    if (/\b(gambar|image|poster|logo)\b/i.test(prompt)) return "image";
    return "text";
  }
}
