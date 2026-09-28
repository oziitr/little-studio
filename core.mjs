export function sceneCountFor(length) {
  return length === 'long' ? 6 : 3;
}

export function validateProject(input) {
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const idea = text(input.idea, 4000);
  let title = text(input.title, 120);
  if (!idea && !title) throw new Error('Hikâyeni yaz.');
  if (!title) {
    title = (idea.split(/[.!?\n]/)[0] || idea || 'Yeni hikâye').slice(0, 80).trim() || 'Yeni hikâye';
  }
  const scenes = (Array.isArray(input.scenes) ? input.scenes : []).slice(0, 12).map(s => ({
    visual: text(s.visual, 3000), motion: text(s.motion, 2000), narration: text(s.narration, 1500), duration: 8
  }));
  const length = input.length === 'long' ? 'long' : 'short';
  const sceneCount = input.sceneCount
    ? Math.min(12, Math.max(3, Math.round(Number(input.sceneCount))))
    : sceneCountFor(length);
  return {
    title,
    idea,
    character: text(input.character, 2000),
    language: ['en', 'tr'].includes(input.language) ? input.language : 'en',
    age: ['3-5', '6-8', '9-12'].includes(input.age) ? input.age : '6-8',
    style: text(input.style, 120) || 'Yumuşak 3D animasyon',
    length,
    sceneCount,
    scenes,
    madeForKids: true,
    subtitles: input.subtitles !== false
  };
}

export function inventIdeaPrompt(p) {
  const lang = p.language === 'tr' ? 'Turkish' : 'English';
  return (
    `Invent ONE original kids YouTube Shorts story idea (ages ${p.age}). ` +
    `Later voiceover will be ${lang} only. Cute animals/friendship/kindness. No franchises.\n` +
    `JSON only: {"title":"short title","idea":"2-4 sentence idea"}`
  );
}

export function storyPrompt(p) {
  const want = p.sceneCount || sceneCountFor(p.length);
  const lang = p.language === 'tr' ? 'Turkish' : 'English';
  return (
    `${want}-scene kids Short plan, ages ${p.age}, style ${p.style}, spoken ${lang} only.\n` +
    `Idea:\n${p.idea}\n` +
    (p.character ? `Character: ${p.character}\n` : '') +
    `JSON only: {"scenes":[{"visual":"","motion":"","narration":""}]} exactly ${want} scenes.`
  );
}
