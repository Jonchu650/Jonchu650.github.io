function openLinkedProject(){
  const project=document.getElementById(location.hash.slice(1));
  if(project instanceof HTMLDetailsElement) project.open=true;
}
const themeButton=document.querySelector('.theme-toggle');
function updateThemeLabel(){
  const dark=document.documentElement.dataset.theme!=='light';
  themeButton.setAttribute('aria-label',`Switch to ${dark?'light':'dark'} mode`);
  themeButton.querySelector('.theme-label').textContent=dark?'Light':'Dark';
  document.querySelector('meta[name="theme-color"]').content=dark?'#111310':'#f7f7f3';
}
themeButton.addEventListener('click',()=>{
  const next=document.documentElement.dataset.theme==='light'?'dark':'light';
  document.documentElement.dataset.theme=next;
  try{localStorage.setItem('portfolio-theme',next)}catch(e){}
  updateThemeLabel();
});
updateThemeLabel();
const cortana=document.getElementById('cortana');
const stage=document.getElementById('sphere-stage');
const pauseButton=document.getElementById('sphere-pause');
const focusButton=document.getElementById('sphere-focus');
const delegateButton=document.getElementById('sphere-delegate');
let sphere=null,initializing=null,manuallyPaused=false,inView=false;
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
function syncSphere(){
  if(!sphere)return;
  if(cortana.open&&inView&&!document.hidden&&!manuallyPaused)sphere.resume();else sphere.pause();
}
function loadThree(){
  if(window.THREE)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='assets/cortana/three.min.js';
    script.onload=resolve;script.onerror=reject;document.head.append(script);
  });
}
async function initSphere(){
  if(sphere||initializing)return initializing;
  initializing=(async()=>{
    try{
      await loadThree();
      const {default:Sphere}=await import('./assets/cortana/Sphere.js');
      if(!cortana.open)return;
      // The original Cortana renderer, isolated from all private data and services.
      sphere=new Sphere(document.getElementById('sphere-canvas'),{onFocus:index=>{
        document.getElementById('sphere-caption').textContent=index===0?'Cortana & companions':`Companion ${index} / focused`;
      }});
      sphere.addOrb({id:'portfolio-companion-1',colA:'#64dce2',colB:'#3e8ae8'},{spawn:false});
      sphere.addOrb({id:'portfolio-companion-2',colA:'#efbd75',colB:'#ee668a'},{spawn:false});
      sphere.renderer.setClearColor(0x05090e,1);
      sphere.camera.fov=38;sphere.camera.updateProjectionMatrix();
      for(const orb of sphere.orbs)orb.uniforms.uSize.value=4.4;
      stage.classList.add('is-live');syncSphere();
    }catch(error){
      document.getElementById('sphere-canvas').replaceChildren();
      stage.classList.remove('is-live');
      document.getElementById('sphere-caption').textContent='Cortana & companions · still image';
      pauseButton.hidden=true;focusButton.hidden=true;delegateButton.hidden=true;
    }finally{initializing=null}
  })();return initializing;
}
cortana.addEventListener('toggle',()=>{if(cortana.open)initSphere();syncSphere()});
new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;if(inView&&cortana.open)initSphere();syncSphere()},{threshold:.05}).observe(stage);
document.addEventListener('visibilitychange',syncSphere);
pauseButton.addEventListener('click',()=>{
  manuallyPaused=!manuallyPaused;pauseButton.setAttribute('aria-pressed',String(manuallyPaused));
  pauseButton.textContent=manuallyPaused?'Resume motion':'Pause motion';focusButton.disabled=manuallyPaused;delegateButton.disabled=manuallyPaused;syncSphere();
});
focusButton.addEventListener('click',()=>{if(sphere){sphere.focusNext();if(manuallyPaused){sphere.resume();requestAnimationFrame(()=>sphere.pause())}}});
let delegationTimer;
delegateButton.addEventListener('click',()=>{
  if(!sphere||manuallyPaused)return;
  sphere.dispatchTo('portfolio-companion-1');
  document.getElementById('sphere-caption').textContent='Visual demo / Cortana delegates to a companion';
  delegateButton.disabled=true;
  clearTimeout(delegationTimer);
  delegationTimer=setTimeout(()=>{
    sphere.returnFrom('portfolio-companion-1');
    document.getElementById('sphere-caption').textContent='Visual demo / the companion returns its work';
    delegateButton.disabled=manuallyPaused;
  },2400);
});
function updateMotionControls(){pauseButton.hidden=reducedMotion.matches;delegateButton.hidden=reducedMotion.matches}
reducedMotion.addEventListener('change',updateMotionControls);updateMotionControls();
window.addEventListener('hashchange',openLinkedProject);openLinkedProject();

if(cortana.open)initSphere();
