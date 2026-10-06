import {animateViewEntry, cancelViewEntries} from './view-transitions.js?v=5';

const arrow = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14" stroke="currentColor" stroke-width="1.5"/></svg>';

export function landingMarkup(auth, icon) {
  return `<div class="landing" id="landing-top">
    <a class="landing-skip" href="#auth-entry">跳到登录与注册</a>
    <header class="landing-nav">
      <a class="landing-brand" href="#landing-top" aria-label="循序首页"><img class="landing-logo" src="/assets/logo.svg" alt="" width="43" height="43">循序<span>XUNXU</span></a>
      <div class="landing-nav-actions"><button type="button" class="landing-motion" aria-pressed="false" aria-label="暂停动态效果" title="暂停动态效果">Ⅱ</button><button type="button" class="landing-login" data-action="auth-jump" data-mode="login">登录账号 <i></i></button></div>
      <span class="landing-scroll-progress" aria-hidden="true"></span>
    </header>
    <main>
      <section class="landing-journey" aria-labelledby="journey-title"><div class="journey-orbit" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><p>从一次小小的行动开始</p><h1 id="journey-title" class="landing-reveal">今天的记录，<br>就是下一步的起点。</h1><button type="button" class="landing-pill" data-action="auth-jump" data-mode="register">开始记录 <i>${arrow}</i></button><a class="landing-scroll-cue" href="#landing-story"><span>向下滑动，查看详情</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v16m-6-6 6 6 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a></section>
      <section class="landing-hero" aria-labelledby="landing-heading" hidden>
        <div class="landing-hero-copy"><a class="landing-back" href="#landing-top">← 返回首页</a><p class="landing-eyebrow">循序 · 训练与饮食记录</p><h1 id="landing-heading"><span>安排好今天，</span><span>看见每一点进步。</span></h1><p class="landing-hero-description">把训练和饮食记在一起，<br>让下一步更清楚。</p><ul class="landing-hero-benefits"><li>${icon('check')}按自己的时间安排训练</li><li>${icon('check')}记录每一餐，查看营养目标</li><li>${icon('check')}用动作演示了解怎么练</li></ul><a class="landing-round-link" href="#landing-features">看看循序能做什么 <i>${arrow}</i></a><p class="landing-device-note">电脑与手机，使用同一个账号。</p></div>
        <div class="landing-auth-panel" id="auth-entry" data-auth-panel>${auth}</div>
      </section>
      <section class="landing-intro" id="landing-story" aria-labelledby="landing-intro-title">
        <div><p class="landing-eyebrow">按你的节奏来</p><h2 class="landing-display landing-reveal" id="landing-intro-title"><span>安排可以调整，</span><span>记录会留下来。</span></h2></div>
        <div class="landing-intro-bottom"><p class="landing-story-text">${['从一周能练几天开始，安排适合自己的计划。','记下完成的训练和每天的饮食，回看变化。','临时有事就改期，让下一次行动更容易。'].map(s=>`<span>${s}</span>`).join('')}</p></div>
      </section>
      <section class="landing-features" id="landing-features" aria-labelledby="landing-features-title">
        <header class="landing-section-heading"><div><p class="landing-eyebrow">日常需要的，都在这里</p><h2 id="landing-features-title" class="landing-reveal">计划、记录，一目了然</h2></div><p>练习、饮食、提问、学习。<br>从你今天需要的开始。</p></header>
        <div class="landing-project-grid">
          <article class="landing-project" id="landing-training">
            <div class="project-visual project-training landing-reveal"><span class="project-overline">01 / 训练安排</span><div class="training-orb" aria-hidden="true"></div><div class="landing-workout-demo"><div class="demo-head"><span>循序 / TODAY</span>${icon('dumbbell')}</div><h3>全身唤醒计划</h3><div class="landing-demo-tasks">${[['深蹲','3 组 × 12 次'],['俯卧撑','3 组 × 10 次'],['平板支撑','3 组 × 30 秒']].map(([name,sets])=>`<button class="landing-demo-task" type="button" aria-pressed="false"><i>${icon('check')}</i><span>${name}<small>${sets}</small></span><span>↗</span></button>`).join('')}</div><div class="landing-demo-progress"><span aria-live="polite">完成 0 / 3 个动作</span><div><i></i></div></div></div><span class="project-note">交互示例 · 点击勾选动作</span></div>
            <div class="project-meta"><p>训练日程</p><button type="button" data-action="auth-jump" data-mode="register"><h3 id="landing-training-title">今天练什么，一眼清楚。</h3>${arrow}</button><p class="project-description">按周安排动作和组数，完成后记录；时间有变，随时调整。</p></div>
          </article>
          <article class="landing-project" id="landing-nutrition">
            <div class="project-visual project-nutrition landing-reveal"><span class="project-overline">02 / 饮食记录</span><div class="nutrition-type" aria-hidden="true">EAT<br>WELL.</div><div class="nutrition-plate" aria-hidden="true"><div class="salad-leaf leaf-a"></div><div class="salad-leaf leaf-b"></div><div class="salad-leaf leaf-c"></div><div class="salad-leaf leaf-d"></div><div class="tomato tomato-a"></div><div class="tomato tomato-b"></div><div class="food-egg"></div><div class="food-avocado"></div></div><div class="nutrition-facts"><div><span data-meal-name>均衡午餐</span><strong data-meal-calories>620 <small>kcal</small></strong></div><p data-meal-macros>蛋白质 35 g · 碳水 75 g · 脂肪 20 g</p><button class="demo-cycle" type="button" data-demo="meal">换一餐看看 ${arrow}</button></div><span class="project-note">营养示例 · 实际记录可核对修改</span></div>
            <div class="project-meta"><p>饮食记录</p><button type="button" data-action="auth-jump" data-mode="register"><h3 id="landing-nutrition-title">吃了什么，随手记下。</h3>${arrow}</button><p class="project-description">用照片或文字记录餐食，核对份量，了解当天的营养摄入。</p></div>
          </article>
          <article class="landing-project" id="landing-companion">
            <div class="project-visual project-chat landing-reveal"><span class="project-overline">03 / AI 陪伴</span><div class="chat-orb" aria-hidden="true"><img src="/assets/logo.svg" alt="" width="220" height="220"></div><div class="demo-conversation" aria-live="polite"><p class="demo-question">这周只有三天时间，可以怎么练？</p><div class="demo-answer"><span>循序 AI</span><h3>从你的时间出发。</h3><p>结合目标、可用器械与训练记录，<br>一起安排适合你的训练日程。</p><div class="demo-chat-dots" aria-hidden="true"><i></i><i></i><i></i></div></div></div><button type="button" class="demo-cycle" data-demo="chat">换个问题 ${arrow}</button><span class="project-note">对话示例 · 连接自己的 AI 服务后使用</span></div>
            <div class="project-meta"><p>AI 对话</p><button type="button" data-action="auth-jump" data-mode="register"><h3 id="landing-companion-title">有问题，一起理清楚。</h3>${arrow}</button><p class="project-description">把目标、时间和困惑告诉 AI，一起讨论下一步怎么安排。</p></div>
          </article>
          <article class="landing-project" id="landing-knowledge">
            <div class="project-visual project-knowledge landing-reveal"><span class="project-overline">04 / 动作知识</span><div class="knowledge-grid" aria-hidden="true"></div><div class="knowledge-cover"><img src="/assets/exercises/pushup.jpg" alt="俯卧撑动作预览" loading="lazy" width="400" height="400"><span data-exercise-name>俯卧撑 / PUSH UP</span></div><div class="knowledge-label label-top">动作 · 发力 · 理解</div><button type="button" class="demo-cycle" data-demo="exercise">下一个动作 ${arrow}</button><span class="project-note">进入知识库，查看 3D 肌群与动作演示</span></div>
            <div class="project-meta"><p>动作知识</p><button type="button" data-action="auth-jump" data-mode="register"><h3>先看懂，再开始练。</h3>${arrow}</button><p class="project-description">查看动作演示与发力肌群，把不熟悉的动作了解清楚。</p></div>
          </article>
        </div>
      </section>
    </main><footer class="landing-footer"><a class="landing-brand" href="#landing-top" aria-label="循序首页"><img class="landing-logo" src="/assets/logo.svg" alt="" width="43" height="43">循序<span>XUNXU</span></a><p>安排好今天，记住每一点进步。</p><a href="#landing-top">回到顶部 ${arrow}</a><div>© ${new Date().getFullYear()} 循序 · AI 健身助手</div></footer>
  </div>`;
}

export function mountLanding(root, {onAuthRoute} = {}) {
  const controller=new AbortController();const {signal}=controller;
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  const motionButton=root.querySelector('.landing-motion');
  const progressBar=root.querySelector('.landing-scroll-progress');
  const {gsap,ScrollTrigger}=window;
  const textTargets=root.querySelectorAll('.landing-hero h1>span,.landing-display>span,.landing-section-heading h2,.landing-journey h1,.project-meta h3,.landing-story-text span');
  textTargets.forEach(el=>el.classList.add('landing-gradient-text'));
  let paused=false,frame=0,motionContext=null,mealIndex=0,questionIndex=0,exerciseIndex=0;
  const isReduced=()=>paused||media.matches;
  const paint=()=>{frame=0;const max=document.documentElement.scrollHeight-innerHeight;progressBar.style.transform=`scaleX(${max>0?Math.min(1,scrollY/max):0})`;root.classList.toggle('is-scrolled',scrollY>50);};
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(paint);};
  const updateMotion=()=>{
    motionContext?.revert();motionContext=null;
    root.querySelectorAll('.landing-story-text span').forEach(el=>el.style.removeProperty('opacity'));
    root.classList.toggle('motion-paused',isReduced());
    if(isReduced())cancelViewEntries(root);
    motionButton.setAttribute('aria-pressed',String(isReduced()));motionButton.setAttribute('aria-label',media.matches?'已跟随系统减少动态效果':paused?'开启动态效果':'暂停动态效果');
    motionButton.title=motionButton.getAttribute('aria-label');motionButton.textContent=isReduced()?'▷':'Ⅱ';motionButton.disabled=media.matches;
    if(!isReduced()&&gsap&&ScrollTrigger){
      gsap.registerPlugin(ScrollTrigger);motionContext=gsap.matchMedia();
      motionContext.add('(min-width: 0px)',()=>{
        // Crossing the threshold starts a complete timed sequence, even at rest.
        for(const text of textTargets){
          if(text.closest('[hidden]'))continue;
          gsap.fromTo(text,{opacity:0,y:32,rotationX:-18},{opacity:1,y:0,rotationX:0,duration:.95,ease:'power3.out',force3D:true,scrollTrigger:{trigger:text,start:'top 88%',toggleActions:'play none none reverse'}});
        }
        for(const [index,visual] of [...root.querySelectorAll('.project-visual')].entries()){
          if(visual.closest('[hidden]'))continue;
          const direction=index%2?1:-1;
          gsap.timeline({scrollTrigger:{trigger:visual.closest('.landing-project'),start:'top 82%',toggleActions:'play none none reverse'}})
            .fromTo(visual,{scaleX:.58,scaleY:.68,y:42,rotation:direction*9},{scaleX:1.035,scaleY:.965,y:-5,rotation:-direction*2,duration:.75,ease:'power2.out',force3D:true})
            .to(visual,{scaleX:.99,scaleY:1.02,y:0,rotation:direction*.6,duration:.25,ease:'sine.inOut'})
            .to(visual,{scaleX:1,scaleY:1,rotation:0,duration:.3,ease:'sine.out'});
        }
        if(!root.classList.contains('is-auth-page'))gsap.fromTo(root.querySelector('.journey-orbit'),{scale:.7,rotation:-70},{scale:1,rotation:0,duration:1.6,ease:'power2.out',force3D:true,scrollTrigger:{trigger:root.querySelector('.landing-journey'),start:'top 85%',toggleActions:'play none none reverse'}});

      },root);
    }schedule();
  };
  motionButton.addEventListener('click',()=>{paused=!paused;updateMotion();},{signal});media.addEventListener('change',updateMotion,{signal});
  window.addEventListener('scroll',schedule,{passive:true,signal});window.addEventListener('resize',schedule,{passive:true,signal});
  const resize=new ResizeObserver(schedule);resize.observe(root);
  root.addEventListener('click',event=>{
    const anchor=event.target.closest('a[href^="#"]');if(anchor){
      event.preventDefault();
      const hash=anchor.getAttribute('href');
      if(location.hash===hash)syncRoute();else location.hash=hash;
    }
    const task=event.target.closest('.landing-demo-task');if(task){task.setAttribute('aria-pressed',String(task.getAttribute('aria-pressed')!=='true'));const count=root.querySelectorAll('.landing-demo-task[aria-pressed=true]').length;root.querySelector('.landing-demo-progress>span').textContent=count===3?'今天的练习，完成！':`完成 ${count} / 3 个动作`;root.querySelector('.landing-demo-progress i').style.width=`${count/3*100}%`;}
    const demo=event.target.closest('[data-demo]')?.dataset.demo;
    if(demo==='meal'){
      const meals=[['均衡午餐',620,'蛋白质 35 g · 碳水 75 g · 脂肪 20 g'],['轻盈早餐',380,'蛋白质 22 g · 碳水 46 g · 脂肪 12 g'],['训练后的一餐',540,'蛋白质 42 g · 碳水 66 g · 脂肪 12 g']];const [name,calories,macros]=meals[++mealIndex%meals.length];root.querySelector('[data-meal-name]').textContent=name;root.querySelector('[data-meal-calories]').innerHTML=`${calories} <small>kcal</small>`;root.querySelector('[data-meal-macros]').textContent=macros;root.querySelector('.nutrition-plate').style.rotate=`${mealIndex*30-12}deg`;
    }
    if(demo==='chat'){
      const questions=[['这周只有三天时间，可以怎么练？','从你的时间出发。','结合目标、可用器械与训练记录，一起安排适合你的训练日程。'],['今天想练腿，从哪里开始？','先找到适合你的强度。','说说你的训练经验、可用器械与身体状态，我们一起规划。'],['晚餐想吃得均衡一点。','从你喜欢的食物开始。','聊聊今天吃了什么，一起找更适合你的搭配与份量。']];const [q,h,p]=questions[++questionIndex%questions.length];root.querySelector('.demo-question').textContent=q;root.querySelector('.demo-answer h3').textContent=h;root.querySelector('.demo-answer p').textContent=p;
    }
    if(demo==='exercise'){
      const exercises=[['pushup','俯卧撑 / PUSH UP'],['squat','深蹲 / SQUAT'],['plank','平板支撑 / PLANK']];const [id,name]=exercises[++exerciseIndex%exercises.length];const img=root.querySelector('.knowledge-cover img');img.src=`/assets/exercises/${id}.jpg`;img.alt=name+'动作预览';root.querySelector('[data-exercise-name]').textContent=name;
    }
  },{signal});
  const reveal=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('is-visible');reveal.unobserve(entry.target);}},{threshold:.08});root.querySelectorAll('.landing-reveal').forEach(el=>reveal.observe(el));
  const ambient=new IntersectionObserver(entries=>{for(const entry of entries)entry.target.classList.toggle('motion-in-view',entry.isIntersecting);},{rootMargin:'80px'});
  root.querySelectorAll('.landing-journey,.project-visual').forEach(el=>ambient.observe(el));
  const syncRoute=(focus=true)=>{
    const authPage=['#auth-entry','#auth-register'].includes(location.hash);
    const changed=root.classList.contains('is-auth-page')!==authPage;
    root.classList.toggle('is-auth-page',authPage);
    root.querySelectorAll('main>section').forEach(section=>{section.hidden=section.classList.contains('landing-hero')?!authPage:authPage;});
    root.querySelector('.landing-footer').hidden=authPage;
    if(authPage)onAuthRoute?.(location.hash==='#auth-register'?'register':'login');
    if(changed||!focus)updateMotion();
    ScrollTrigger?.refresh();
    const target=authPage?root.querySelector('#auth-entry'):[...root.querySelectorAll('[id]')].find(el=>'#'+el.id===location.hash)||root;
    if(authPage||changed||target===root)window.scrollTo({top:0,behavior:'instant'});
    if(target!==root&&(!authPage||matchMedia('(max-width:760px)').matches))target.scrollIntoView({behavior:changed||!focus||isReduced()?'instant':'smooth'});
    if(changed)animateViewEntry(authPage?root.querySelector('.landing-hero'):root.querySelector('main'));
    if(focus){const heading=authPage?root.querySelector('#landing-auth-heading'):target.querySelector('h1,h2,h3')||target;heading.setAttribute('tabindex','-1');heading.focus({preventScroll:true});}
    paint();
  };
  window.addEventListener('hashchange',()=>syncRoute(),{signal});
  root.classList.add('motion-ready');syncRoute(false);document.fonts.ready.then(()=>{if(!signal.aborted)ScrollTrigger?.refresh();});
  return ()=>{controller.abort();motionContext?.revert();resize.disconnect();reveal.disconnect();ambient.disconnect();if(frame)cancelAnimationFrame(frame);};
}
