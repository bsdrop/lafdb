const CHO = [
	"ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
	"ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
] as const;

const JUNG = [
	"ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅗㅏ",
	"ㅗㅐ", "ㅗㅣ", "ㅛ", "ㅜ", "ㅜㅓ", "ㅜㅔ", "ㅜㅣ", "ㅠ", "ㅡ", "ㅡㅣ", "ㅣ",
] as const;

const JONG = [
	"", "ㄱ", "ㄲ", "ㄱㅅ", "ㄴ", "ㄴㅈ", "ㄴㅎ", "ㄷ", "ㄹ", "ㄹㄱ",
	"ㄹㅁ", "ㄹㅂ", "ㄹㅅ", "ㄹㅌ", "ㄹㅍ", "ㄹㅎ", "ㅁ", "ㅂ", "ㅂㅅ", "ㅅ",
	"ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
] as const;

const C: Record<string, string> = {
	ㄱ: "ㄱ", ㄲ: "ㄲ", ㄳ: "ㄱㅅ", ㄴ: "ㄴ", ㄵ: "ㄴㅈ", ㄶ: "ㄴㅎ",
	ㄷ: "ㄷ", ㄸ: "ㄸ", ㄹ: "ㄹ", ㄺ: "ㄹㄱ", ㄻ: "ㄹㅁ", ㄼ: "ㄹㅂ",
	ㄽ: "ㄹㅅ", ㄾ: "ㄹㅌ", ㄿ: "ㄹㅍ", ㅀ: "ㄹㅎ", ㅁ: "ㅁ",
	ㅂ: "ㅂ", ㅃ: "ㅃ", ㅄ: "ㅂㅅ", ㅅ: "ㅅ", ㅆ: "ㅆ",
	ㅇ: "ㅇ", ㅈ: "ㅈ", ㅉ: "ㅉ", ㅊ: "ㅊ", ㅋ: "ㅋ", ㅌ: "ㅌ", ㅍ: "ㅍ", ㅎ: "ㅎ",
};

const V: Record<string, string> = {
	ㅏ: "ㅏ", ㅐ: "ㅐ", ㅑ: "ㅑ", ㅒ: "ㅒ", ㅓ: "ㅓ", ㅔ: "ㅔ",
	ㅕ: "ㅕ", ㅖ: "ㅖ", ㅗ: "ㅗ", ㅘ: "ㅗㅏ", ㅙ: "ㅗㅐ", ㅚ: "ㅗㅣ",
	ㅛ: "ㅛ", ㅜ: "ㅜ", ㅝ: "ㅜㅓ", ㅞ: "ㅜㅔ", ㅟ: "ㅜㅣ",
	ㅠ: "ㅠ", ㅡ: "ㅡ", ㅢ: "ㅡㅣ", ㅣ: "ㅣ",
};

export const getChoseong = (s: string) => {
	let out = "";
	for (const ch of s) {
		const code = ch.charCodeAt(0) - 44032;
		if (code >= 0 && code < 11172) {
			const jong = code % 28;
			const cho = ((code - jong) / 28 / 21) | 0;
			out += CHO[cho];
			continue;
		}
		if (ch === " ") {
			out += ch;
			continue;
		}
		if (C[ch]) {
			out += C[ch];
			continue;
		}
	}
	return out;
};

export const disassemble = (s: string) => {
	let out = "";

	for (const ch of s) {
		const code = ch.charCodeAt(0) - 44032;

		if (code >= 0 && code < 11172) {
			const jong = code % 28;
			const jung = ((code - jong) / 28) % 21;
			const cho = ((code - jong) / 28 / 21) | 0;

			out += CHO[cho] + JUNG[jung] + JONG[jong];
			continue;
		}

		out += C[ch] ?? V[ch] ?? ch;
	}

	return out;
};
