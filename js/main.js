const toggle = document.getElementById('themeToggle');
const html = document.documentElement;

toggle.addEventListener('click', () => {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

const nav = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const siblings = entry.target.parentElement.querySelectorAll('.fade-in');
      const idx = Array.from(siblings).indexOf(entry.target);
      entry.target.style.transitionDelay = `${idx * 0.06}s`;
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));

// Lightbox
const lightbox = document.getElementById('lightbox');
if (lightbox) {
  const lbImg = document.getElementById('lightboxImg');
  const lbClose = document.getElementById('lightboxClose');
  let lastFocused = null;

  function openLightbox(img) {
    lastFocused = document.activeElement;
    lbImg.src = img.src;
    lbImg.alt = img.alt;
    lightbox.classList.add('active');
    lightbox.setAttribute('aria-hidden', 'false');
    lbClose.focus();
  }

  function closeLightbox() {
    lightbox.classList.remove('active');
    lightbox.setAttribute('aria-hidden', 'true');
    lbImg.removeAttribute('src');
    if (lastFocused) lastFocused.focus();
  }

  document.querySelectorAll('[data-lightbox]').forEach(img => {
    img.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(img); });
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(img); }
    });
  });

  lightbox.addEventListener('click', (e) => { if (e.target !== lbImg) closeLightbox(); });
  lbClose.addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox.classList.contains('active')) closeLightbox();
  });

  // Focus trap inside lightbox
  lightbox.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); lbClose.focus(); }
  });
}
